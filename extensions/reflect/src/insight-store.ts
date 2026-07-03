// Reflect persistence over the plugin keyed state store: insights, run summaries, token budget.
import { randomBytes } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type {
  ReflectConfig,
  ReflectInsightInput,
  ReflectInsightRecord,
  ReflectInsightStore,
  ReflectRunSummary,
} from "./types.js";

const DAY_MS = 86_400_000;
const RUNS_MAX_ENTRIES = 200;
const RUNS_TTL_MS = 14 * DAY_MS;
const BUDGET_MAX_ENTRIES = 16;
const BUDGET_TTL_MS = 3 * DAY_MS;

type ReflectOpenStore = <T>(options: {
  namespace: string;
  maxEntries: number;
  defaultTtlMs?: number;
}) => PluginStateKeyedStore<T>;

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/);
  return new Set(words.filter((word) => word.length > 0));
}

/** Token-set Jaccard similarity for near-duplicate detection; both-empty counts as identical. */
export function similarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 && tokensB.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection += 1;
    }
  }
  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union;
}

// On merge the higher composite score owns all scored content fields; ties keep
// the existing record so repeated identical inserts stay stable.
function mergeRecords(
  existing: ReflectInsightRecord,
  incoming: ReflectInsightInput,
  updatedAt: number,
): ReflectInsightRecord {
  const winner: ReflectInsightInput = incoming.score > existing.score ? incoming : existing;
  // The draft survives even when the winner has none (synthesis is best-effort and
  // budget-capped); losing a banked draft would drop the operator's review artifact.
  const wouldSurfaceText =
    winner.wouldSurfaceText ?? existing.wouldSurfaceText ?? incoming.wouldSurfaceText;
  return {
    id: existing.id,
    agentId: existing.agentId,
    ...(existing.sessionKey !== undefined ? { sessionKey: existing.sessionKey } : {}),
    tier: existing.tier === "surface" || incoming.tier === "surface" ? "surface" : "defer",
    score: winner.score,
    novelty: winner.novelty,
    relevance: winner.relevance,
    actionability: winner.actionability,
    insight: winner.insight,
    ...(wouldSurfaceText !== undefined ? { wouldSurfaceText } : {}),
    provenance: winner.provenance,
    promptPreview: existing.promptPreview,
    createdAt: existing.createdAt,
    updatedAt,
    dedupeCount: existing.dedupeCount + 1,
    ...(existing.feedback !== undefined ? { feedback: existing.feedback } : {}),
    ...(existing.feedbackAt !== undefined ? { feedbackAt: existing.feedbackAt } : {}),
  };
}

export function createReflectInsightStore(opts: {
  openStore: ReflectOpenStore;
  storeConfig: ReflectConfig["store"];
  now(): number;
}): ReflectInsightStore {
  const { openStore, storeConfig } = opts;
  const now = (): number => opts.now();
  let insights: PluginStateKeyedStore<ReflectInsightRecord> | undefined;
  let runs: PluginStateKeyedStore<ReflectRunSummary> | undefined;
  let budget: PluginStateKeyedStore<number> | undefined;

  const insightsStore = () =>
    (insights ??= openStore<ReflectInsightRecord>({
      namespace: "insights",
      maxEntries: storeConfig.maxEntries,
      defaultTtlMs: storeConfig.ttlDays * DAY_MS,
    }));
  const runsStore = () =>
    (runs ??= openStore<ReflectRunSummary>({
      namespace: "runs",
      maxEntries: RUNS_MAX_ENTRIES,
      defaultTtlMs: RUNS_TTL_MS,
    }));
  const budgetStore = () =>
    (budget ??= openStore<number>({
      namespace: "budget",
      maxEntries: BUDGET_MAX_ENTRIES,
      defaultTtlMs: BUDGET_TTL_MS,
    }));

  return {
    async addInsight(input) {
      const store = insightsStore();
      let best: ReflectInsightRecord | undefined;
      let bestSimilarity = -1;
      for (const entry of await store.entries()) {
        if (entry.value.agentId !== input.agentId) {
          continue;
        }
        const score = similarity(entry.value.insight, input.insight);
        if (score > bestSimilarity) {
          bestSimilarity = score;
          best = entry.value;
        }
      }
      const at = now();
      if (best && bestSimilarity >= storeConfig.dedupeSimilarity) {
        // Re-registering refreshes the row's write time, so merged records also
        // move to the back of the store's oldest-first eviction order.
        await store.register(best.id, mergeRecords(best, input, at));
        return { id: best.id, deduped: true };
      }
      const id = randomBytes(4).toString("hex");
      // The sqlite store evicts oldest-write rows itself when a register pushes
      // the namespace past maxEntries; overflow never throws here.
      await store.register(id, { ...input, id, createdAt: at, updatedAt: at, dedupeCount: 0 });
      return { id, deduped: false };
    },

    async listInsights(listOpts) {
      const records = (await insightsStore().entries())
        .map((entry) => entry.value)
        .filter((record) => listOpts?.agentId === undefined || record.agentId === listOpts.agentId);
      records.sort((a, b) => b.updatedAt - a.updatedAt);
      return listOpts?.limit !== undefined ? records.slice(0, listOpts.limit) : records;
    },

    async getInsight(id) {
      return await insightsStore().lookup(id);
    },

    async rateInsight(id, feedback, rateOpts) {
      const store = insightsStore();
      const at = now();
      // Agent scoping: a session may only rate its own agent's records; foreign
      // ids behave exactly like missing ones so ownership is not probeable.
      const owns = (record: ReflectInsightRecord) =>
        rateOpts?.agentId === undefined || record.agentId === rateOpts.agentId;
      if (store.update) {
        return await store.update(id, (current) =>
          current === undefined || !owns(current)
            ? undefined
            : { ...current, feedback, feedbackAt: at },
        );
      }
      const current = await store.lookup(id);
      if (!current || !owns(current)) {
        return false;
      }
      await store.register(id, { ...current, feedback, feedbackAt: at });
      return true;
    },

    async addRunSummary(run) {
      await runsStore().register(run.id, run);
    },

    async listRunSummaries(listOpts) {
      const summaries = (await runsStore().entries())
        .map((entry) => entry.value)
        .filter((run) => listOpts?.agentId === undefined || run.agentId === listOpts.agentId);
      summaries.sort((a, b) => b.startedAt - a.startedAt);
      return listOpts?.limit !== undefined ? summaries.slice(0, listOpts.limit) : summaries;
    },

    async addDailyTokens(dayKey, tokens) {
      const store = budgetStore();
      if (store.update) {
        // update() runs the read-modify-write in one store transaction.
        let total = 0;
        await store.update(dayKey, (current) => {
          total = (current ?? 0) + tokens;
          return total;
        });
        return total;
      }
      const total = ((await store.lookup(dayKey)) ?? 0) + tokens;
      await store.register(dayKey, total);
      return total;
    },

    async getDailyTokens(dayKey) {
      return (await budgetStore().lookup(dayKey)) ?? 0;
    },

    async clearAll() {
      await Promise.all([insightsStore().clear(), runsStore().clear(), budgetStore().clear()]);
    },
  };
}
