// /reflect command parsing and rendering. Pure and injectable: callers supply store, config, and clock.
import { utcDayKey } from "./config.js";
import type {
  ReflectConfig,
  ReflectFeedback,
  ReflectInsightRecord,
  ReflectInsightStore,
} from "./types.js";

export type ReflectCommandAction =
  | { kind: "status" }
  | { kind: "digest"; limit: number }
  | { kind: "rate"; id: string; feedback: ReflectFeedback }
  | { kind: "clear" }
  | { kind: "help" }
  | { kind: "unknown"; input: string };

const DIGEST_DEFAULT_LIMIT = 10;
const DIGEST_MAX_LIMIT = 25;
const DRAFT_PREVIEW_CHARS = 200;
const SOURCE_PATHS_SHOWN = 3;

const REFLECT_USAGE = [
  "Reflect commands:",
  "  /reflect status - show shadow-mode status",
  "  /reflect digest [n] - list latest banked insights (default 10, max 25)",
  "  /reflect rate <id> up|down - rate a banked insight",
  "  /reflect clear - clear all Reflect data (owner only)",
].join("\n");

function parseDigestLimit(token: string | undefined): number {
  if (token === undefined) {
    return DIGEST_DEFAULT_LIMIT;
  }
  const parsed = Number.parseInt(token, 10);
  if (!Number.isFinite(parsed)) {
    return DIGEST_DEFAULT_LIMIT;
  }
  return Math.min(DIGEST_MAX_LIMIT, Math.max(1, parsed));
}

export function parseReflectCommand(args: string | undefined): ReflectCommandAction {
  const input = args?.trim() ?? "";
  const tokens = input.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { kind: "status" };
  }
  const verb = tokens[0].toLowerCase();
  if (verb === "status") {
    return { kind: "status" };
  }
  if (verb === "digest") {
    return { kind: "digest", limit: parseDigestLimit(tokens[1]) };
  }
  if (verb === "rate") {
    // The digest renders ids as #<id>, so accept the natural copied form too.
    const id = tokens[1]?.replace(/^#/, "");
    const feedback = tokens[2]?.toLowerCase();
    if (!id || (feedback !== "up" && feedback !== "down")) {
      return { kind: "unknown", input };
    }
    return { kind: "rate", id, feedback };
  }
  if (verb === "clear") {
    return { kind: "clear" };
  }
  if (verb === "help") {
    return { kind: "help" };
  }
  return { kind: "unknown", input };
}

type HandleReflectCommandParams = {
  action: ReflectCommandAction;
  store: ReflectInsightStore;
  config: ReflectConfig;
  /** Agent scope for status/digest/rate: sessions only see their own agent's records. */
  agentId: string;
  senderIsOwner?: boolean;
  now(): number;
  memoryAvailable: boolean;
};

function humanizeAge(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

async function renderStatus(params: HandleReflectCommandParams): Promise<string> {
  const { store, config } = params;
  const now = params.now();
  const spent = await store.getDailyTokens(utcDayKey(now));
  const insights = await store.listInsights({ agentId: params.agentId });
  const [lastRun] = await store.listRunSummaries({ limit: 1, agentId: params.agentId });

  const surfaceCount = insights.filter((record) => record.tier === "surface").length;
  const deferCount = insights.length - surfaceCount;
  const ratedCount = insights.filter((record) => record.feedback !== undefined).length;

  const lines = [
    "Reflect (shadow mode)",
    `Scan model: ${config.scanModel ?? "agent default"}`,
    `Synthesis model: ${config.synthesisModel ?? "agent default"}`,
  ];
  if (!params.memoryAvailable) {
    lines.push("Warning: memory search is unavailable; reflection passes are skipped.");
  }
  lines.push(
    `Today's token spend: ${spent} / ${config.dailyTokenBudget}`,
    `Banked insights: ${insights.length} total (${surfaceCount} surface, ${deferCount} defer, ${ratedCount} rated)`,
    lastRun
      ? `Last run: ${lastRun.outcome}, ${lastRun.iterations} iterations, ${lastRun.tokens.total} tokens, ${humanizeAge(now - lastRun.startedAt)}`
      : "Last run: no runs yet",
  );
  return lines.join("\n");
}

function renderInsight(record: ReflectInsightRecord): string[] {
  const rated = record.feedback ? ` (rated ${record.feedback})` : "";
  const lines = [`#${record.id} [${record.score}/100 ${record.tier}]${rated} ${record.insight}`];

  const paths: string[] = [];
  for (const source of record.provenance) {
    if (!paths.includes(source.path)) {
      paths.push(source.path);
    }
  }
  if (paths.length > 0) {
    const shown = paths.slice(0, SOURCE_PATHS_SHOWN).join(", ");
    const extra =
      paths.length > SOURCE_PATHS_SHOWN ? ` +${paths.length - SOURCE_PATHS_SHOWN} more` : "";
    lines.push(`   sources: ${shown}${extra}`);
  }
  if (record.tier === "surface" && record.wouldSurfaceText) {
    lines.push(`   draft: ${record.wouldSurfaceText.slice(0, DRAFT_PREVIEW_CHARS)}`);
  }
  return lines;
}

async function renderDigest(
  store: ReflectInsightStore,
  agentId: string,
  limit: number,
): Promise<string> {
  const insights = await store.listInsights({ limit, agentId });
  if (insights.length === 0) {
    return "No banked insights yet. Reflection runs in shadow mode after eligible turns.";
  }
  const lines = insights.flatMap(renderInsight);
  lines.push("Rate: /reflect rate <id> up|down");
  return lines.join("\n");
}

export async function handleReflectCommand(
  params: HandleReflectCommandParams,
): Promise<{ text: string }> {
  const { action, store } = params;
  switch (action.kind) {
    case "status":
      return { text: await renderStatus(params) };
    case "digest":
      return { text: await renderDigest(store, params.agentId, action.limit) };
    case "rate": {
      const recorded = await store.rateInsight(action.id, action.feedback, {
        agentId: params.agentId,
      });
      return {
        text: recorded
          ? `Recorded ${action.feedback} for #${action.id}. This tunes future thresholds.`
          : `No insight #${action.id} found (it may have expired).`,
      };
    }
    case "clear": {
      if (params.senderIsOwner !== true) {
        return { text: "Only the owner can clear the Reflect store." };
      }
      await store.clearAll();
      return { text: "Cleared all banked insights, run summaries, and budget counters." };
    }
    case "help":
      return { text: REFLECT_USAGE };
    case "unknown":
      return { text: `Unknown reflect action: ${action.input}\n\n${REFLECT_USAGE}` };
  }
  return action satisfies never;
}
