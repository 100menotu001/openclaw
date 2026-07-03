// Core reflection pass: retrieve memory, iterate cheap-model scans to diminishing returns,
// triage candidates, draft a shadow-mode follow-up, and persist everything for review.
import { randomBytes } from "node:crypto";
import { utcDayKey } from "./config.js";
import {
  buildScanMessages,
  buildSynthesisMessages,
  collapseToSingleLine,
  compositeScore,
  parseScanResponse,
} from "./scan-prompt.js";
import type {
  ReflectConfig,
  ReflectInsightInput,
  ReflectJob,
  ReflectMemoryHit,
  ReflectPipelineDeps,
  ReflectProvenance,
  ReflectRunOutcome,
  ReflectRunSummary,
  ReflectTier,
} from "./types.js";

const MAX_CANDIDATES_PER_SCAN = 5;
const QUERY_MAX_CHARS = 600;
const SEED_SNIPPET_MAX_CHARS = 200;

type CandidateState = {
  insight: string;
  novelty: number;
  relevance: number;
  actionability: number;
  score: number;
  tier: ReflectTier | "discard";
  provenance: ReflectProvenance[];
  wouldSurfaceText?: string;
};

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

function triageTier(score: number, config: ReflectConfig): ReflectTier | "discard" {
  if (score >= config.triage.surfaceThreshold) {
    return "surface";
  }
  return score >= config.triage.deferThreshold ? "defer" : "discard";
}

/** Joins seed snippets into a bounded search query (each seed clipped, total capped). */
function buildSeedQuery(seeds: string[]): string {
  const parts: string[] = [];
  let length = 0;
  for (const seed of seeds) {
    const clipped = seed.slice(0, SEED_SNIPPET_MAX_CHARS);
    const extra = clipped.length + (parts.length > 0 ? 1 : 0);
    if (length + extra > QUERY_MAX_CHARS) {
      break;
    }
    parts.push(clipped);
    length += extra;
  }
  return parts.join("\n");
}

function toProvenance(hit: ReflectMemoryHit): ReflectProvenance {
  return { path: hit.path, startLine: hit.startLine, endLine: hit.endLine, score: hit.score };
}

export async function runReflectionPass(
  deps: ReflectPipelineDeps,
  config: ReflectConfig,
  job: ReflectJob,
  signal: AbortSignal,
): Promise<ReflectRunSummary> {
  const runId = randomBytes(4).toString("hex");
  const startedAt = deps.now();
  const dayKey = utcDayKey(startedAt);
  const sessionKey = job.sessionKey === undefined ? {} : { sessionKey: job.sessionKey };

  const tokensUsed = { input: 0, output: 0, total: 0 };
  const candidates: CandidateState[] = [];
  let iterations = 0;
  let outcome: ReflectRunOutcome = "completed";
  let errorMessage: string | undefined;

  const finish = async (): Promise<ReflectRunSummary> => {
    // Bank whatever the pass found, even on abort/timeout/error; persistence failures are
    // logged and swallowed so a broken store never throws out of a background pass.
    const storedInsightIds: string[] = [];
    const kept = candidates.filter(
      (candidate): candidate is CandidateState & { tier: ReflectTier } =>
        candidate.tier !== "discard",
    );
    try {
      for (const candidate of kept) {
        const input: ReflectInsightInput = {
          agentId: job.agentId,
          ...sessionKey,
          tier: candidate.tier,
          score: candidate.score,
          novelty: candidate.novelty,
          relevance: candidate.relevance,
          actionability: candidate.actionability,
          insight: candidate.insight,
          ...(candidate.wouldSurfaceText === undefined
            ? {}
            : { wouldSurfaceText: candidate.wouldSurfaceText }),
          provenance: candidate.provenance,
          promptPreview: job.userText.slice(0, 160),
        };
        const stored = await deps.store.addInsight(input);
        storedInsightIds.push(stored.id);
      }
    } catch (error) {
      deps.logger.warn(
        `reflect: failed to persist insights for run ${runId}: ${boundedErrorMessage(error)}`,
      );
    }
    const summary: ReflectRunSummary = {
      id: runId,
      agentId: job.agentId,
      ...sessionKey,
      startedAt,
      durationMs: deps.now() - startedAt,
      iterations,
      outcome,
      ...(errorMessage === undefined ? {} : { error: errorMessage }),
      tokens: tokensUsed,
      candidates: candidates.map((candidate) => ({
        score: candidate.score,
        tier: candidate.tier,
        preview: candidate.insight.slice(0, 120),
      })),
      storedInsightIds,
    };
    try {
      await deps.store.addRunSummary(summary);
      if (tokensUsed.total > 0) {
        await deps.store.addDailyTokens(dayKey, tokensUsed.total);
      }
    } catch (error) {
      deps.logger.warn(`reflect: failed to persist run ${runId}: ${boundedErrorMessage(error)}`);
    }
    return summary;
  };

  const search = deps.search;
  if (search === undefined) {
    outcome = "no-memory";
    return finish();
  }
  // Daily budget caps total spend across passes; the loop token budget caps one pass.
  const spentToday = await deps.store.getDailyTokens(dayKey);
  if (spentToday >= config.dailyTokenBudget) {
    outcome = "budget-exhausted";
    return finish();
  }
  // Cap this pass to the day's remaining allowance so a single pass cannot
  // overshoot the daily budget by a full loop budget.
  const loopTokenBudget = Math.min(
    config.convergence.loopTokenBudget,
    config.dailyTokenBudget - spentToday,
  );

  // Track which trigger aborted the internal controller so the outcome can distinguish a
  // caller abort ("aborted") from the pass deadline ("timeout").
  const internal = new AbortController();
  let abortCause: "caller" | "deadline" | undefined;
  const abortInternal = (cause: "caller" | "deadline") => {
    if (abortCause === undefined) {
      abortCause = cause;
      internal.abort();
    }
  };
  const onCallerAbort = () => abortInternal("caller");
  signal.addEventListener("abort", onCallerAbort);
  if (signal.aborted) {
    abortInternal("caller");
  }
  const deadline = setTimeout(
    () => abortInternal("deadline"),
    config.convergence.timeoutSeconds * 1000,
  );
  deadline.unref?.();

  const seenChunkKeys = new Set<string>();
  const keptInsightTexts: string[] = [];
  let nextSeedSnippets: string[] = [];
  let stall = 0;

  try {
    for (let iteration = 0; iteration < config.convergence.maxIterations; iteration++) {
      internal.signal.throwIfAborted();
      iterations++;

      let query: string;
      if (iteration === 0) {
        query = job.userText.slice(0, QUERY_MAX_CHARS);
      } else if (nextSeedSnippets.length === 0) {
        // No source snippets to re-ground on; do not search blind.
        stall++;
        if (stall >= config.convergence.stallIterations) {
          break;
        }
        continue;
      } else {
        query = buildSeedQuery(nextSeedSnippets);
      }

      const hits = await search(query, { maxResults: 8, minScore: 0.3, signal: internal.signal });
      internal.signal.throwIfAborted();
      const newHits = hits.filter((hit) => !seenChunkKeys.has(`${hit.path}:${hit.startLine}`));
      for (const hit of newHits) {
        seenChunkKeys.add(`${hit.path}:${hit.startLine}`);
      }
      if (newHits.length === 0) {
        stall++;
        if (stall >= config.convergence.stallIterations) {
          break;
        }
        continue;
      }

      const scan = await deps.complete({
        ...buildScanMessages({
          userText: job.userText,
          assistantText: job.assistantText,
          newChunks: newHits.map((hit, index) => ({ index, path: hit.path, snippet: hit.snippet })),
          existingInsights: keptInsightTexts,
          iteration,
        }),
        ...(config.scanModel === undefined ? {} : { model: config.scanModel }),
        maxTokens: 1024,
        signal: internal.signal,
        purpose: "reflect-scan",
      });
      tokensUsed.input += scan.tokens.input;
      tokensUsed.output += scan.tokens.output;
      tokensUsed.total += scan.tokens.total;
      internal.signal.throwIfAborted();

      const parsed = parseScanResponse(scan.text, {
        maxCandidates: MAX_CANDIDATES_PER_SCAN,
        chunkCount: newHits.length,
      });
      const keptSeedSnippets: string[] = [];
      for (const { insight, novelty, relevance, actionability, sources } of parsed) {
        const sourceHits = sources.map((index) => newHits[index]);
        const score = compositeScore(novelty, relevance, actionability);
        const tier = triageTier(score, config);
        const provenance = sourceHits.map(toProvenance);
        candidates.push({ insight, novelty, relevance, actionability, score, tier, provenance });
        if (tier !== "discard") {
          keptInsightTexts.push(insight);
          keptSeedSnippets.push(...sourceHits.map((hit) => hit.snippet));
        }
      }

      // Re-grounding contract: the next query is seeded only from retrieved source chunk
      // snippets, never from model-generated insight text, to avoid compounding speculation.
      if (keptSeedSnippets.length > 0) {
        nextSeedSnippets = keptSeedSnippets;
        stall = 0;
      } else {
        stall++;
      }

      if (tokensUsed.total >= loopTokenBudget) {
        break;
      }
      if (stall >= config.convergence.stallIterations) {
        break;
      }
    }

    const surfaced = candidates.filter((candidate) => candidate.tier === "surface");
    const canSynthesize =
      surfaced.length > 0 && tokensUsed.total < loopTokenBudget && !internal.signal.aborted;
    if (canSynthesize) {
      try {
        const synthesis = await deps.complete({
          ...buildSynthesisMessages({
            userText: job.userText,
            surfaced: surfaced.map((candidate) => ({
              insight: candidate.insight,
              paths: [...new Set(candidate.provenance.map((entry) => entry.path))],
            })),
          }),
          ...(config.synthesisModel === undefined ? {} : { model: config.synthesisModel }),
          maxTokens: 512,
          signal: internal.signal,
          purpose: "reflect-synthesis",
        });
        tokensUsed.input += synthesis.tokens.input;
        tokensUsed.output += synthesis.tokens.output;
        tokensUsed.total += synthesis.tokens.total;
        const drafted = collapseToSingleLine(synthesis.text);
        if (drafted) {
          for (const candidate of surfaced) {
            candidate.wouldSurfaceText = drafted;
          }
        }
      } catch (error) {
        if (internal.signal.aborted) {
          throw error;
        }
        // Synthesis is best-effort: surface insights still persist without the draft.
        deps.logger.warn(
          `reflect: synthesis failed for run ${runId}: ${boundedErrorMessage(error)}`,
        );
      }
    }
  } catch (error) {
    if (internal.signal.aborted) {
      outcome = abortCause === "deadline" ? "timeout" : "aborted";
    } else {
      outcome = "error";
      errorMessage = boundedErrorMessage(error);
    }
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", onCallerAbort);
  }

  return finish();
}
