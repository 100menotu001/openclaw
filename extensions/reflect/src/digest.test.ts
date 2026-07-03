import { describe, expect, it } from "vitest";
import { normalizeReflectConfig } from "./config.js";
import type { ReflectCommandAction } from "./digest.js";
import { handleReflectCommand, parseReflectCommand } from "./digest.js";
import type {
  ReflectFeedback,
  ReflectInsightRecord,
  ReflectInsightStore,
  ReflectRunSummary,
} from "./types.js";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function makeInsight(
  overrides: Partial<ReflectInsightRecord> & { id: string },
): ReflectInsightRecord {
  return {
    agentId: "main",
    tier: "defer",
    score: 70,
    novelty: 70,
    relevance: 70,
    actionability: 70,
    insight: "Example insight",
    provenance: [{ path: "memory/notes.md", startLine: 1, endLine: 5, score: 0.8 }],
    promptPreview: "prompt",
    createdAt: NOW,
    updatedAt: NOW,
    dedupeCount: 0,
    ...overrides,
  };
}

function makeRun(overrides: Partial<ReflectRunSummary> & { id: string }): ReflectRunSummary {
  return {
    agentId: "main",
    startedAt: NOW,
    durationMs: 1000,
    iterations: 1,
    outcome: "completed",
    tokens: { input: 100, output: 100, total: 200 },
    candidates: [],
    storedInsightIds: [],
    ...overrides,
  };
}

function makeStore(state?: {
  insights?: ReflectInsightRecord[];
  runs?: ReflectRunSummary[];
  dailyTokens?: Record<string, number>;
}): { store: ReflectInsightStore; wasCleared(): boolean } {
  const insights = state?.insights ?? [];
  const runs = state?.runs ?? [];
  const daily = new Map(Object.entries(state?.dailyTokens ?? {}));
  let cleared = false;
  const store: ReflectInsightStore = {
    async addInsight() {
      return { id: "unused", deduped: false };
    },
    async listInsights(opts) {
      const scoped = insights.filter(
        (record) => opts?.agentId === undefined || record.agentId === opts.agentId,
      );
      return opts?.limit === undefined ? scoped : scoped.slice(0, opts.limit);
    },
    async getInsight(id) {
      return insights.find((record) => record.id === id);
    },
    async rateInsight(id, feedback: ReflectFeedback, opts) {
      const record = insights.find((candidate) => candidate.id === id);
      if (!record || (opts?.agentId !== undefined && record.agentId !== opts.agentId)) {
        return false;
      }
      record.feedback = feedback;
      return true;
    },
    async addRunSummary(run) {
      runs.push(run);
    },
    async listRunSummaries(opts) {
      return opts?.limit === undefined ? [...runs] : runs.slice(0, opts.limit);
    },
    async addDailyTokens(dayKey, tokens) {
      const next = (daily.get(dayKey) ?? 0) + tokens;
      daily.set(dayKey, next);
      return next;
    },
    async getDailyTokens(dayKey) {
      return daily.get(dayKey) ?? 0;
    },
    async clearAll() {
      cleared = true;
      insights.length = 0;
      runs.length = 0;
      daily.clear();
    },
  };
  return { store, wasCleared: () => cleared };
}

function makeParams(overrides?: {
  store?: ReflectInsightStore;
  config?: ReturnType<typeof normalizeReflectConfig>;
  agentId?: string;
  senderIsOwner?: boolean;
  memoryAvailable?: boolean;
}) {
  return {
    store: overrides?.store ?? makeStore().store,
    config: overrides?.config ?? normalizeReflectConfig({}),
    agentId: overrides?.agentId ?? "main",
    senderIsOwner: overrides?.senderIsOwner,
    now: () => NOW,
    memoryAvailable: overrides?.memoryAvailable ?? true,
  };
}

describe("parseReflectCommand", () => {
  const cases: Array<{ input: string | undefined; expected: ReflectCommandAction }> = [
    { input: undefined, expected: { kind: "status" } },
    { input: "", expected: { kind: "status" } },
    { input: "   ", expected: { kind: "status" } },
    { input: "status", expected: { kind: "status" } },
    { input: "digest", expected: { kind: "digest", limit: 10 } },
    { input: "digest 5", expected: { kind: "digest", limit: 5 } },
    { input: "digest 0", expected: { kind: "digest", limit: 1 } },
    { input: "digest 99", expected: { kind: "digest", limit: 25 } },
    { input: "digest abc", expected: { kind: "digest", limit: 10 } },
    { input: "rate x1 up", expected: { kind: "rate", id: "x1", feedback: "up" } },
    { input: "rate x1 DOWN", expected: { kind: "rate", id: "x1", feedback: "down" } },
    { input: "rate x1 sideways", expected: { kind: "unknown", input: "rate x1 sideways" } },
    { input: "rate up", expected: { kind: "unknown", input: "rate up" } },
    { input: "clear", expected: { kind: "clear" } },
    { input: "rate #x1 up", expected: { kind: "rate", id: "x1", feedback: "up" } },
    { input: "rate # up", expected: { kind: "unknown", input: "rate # up" } },
    { input: "help", expected: { kind: "help" } },
    { input: "gibberish x", expected: { kind: "unknown", input: "gibberish x" } },
  ];

  it.each(cases)("parses $input", ({ input, expected }) => {
    expect(parseReflectCommand(input)).toEqual(expected);
  });
});

describe("handleReflectCommand status", () => {
  it("renders defaults with no runs and no insights", async () => {
    const params = makeParams();
    const { text } = await handleReflectCommand({ ...params, action: { kind: "status" } });
    expect(text).toContain("Reflect (shadow mode)");
    expect(text).toContain("Scan model: agent default");
    expect(text).toContain("Synthesis model: agent default");
    expect(text).toContain("Today's token spend: 0 / 50000");
    expect(text).toContain("Banked insights: 0 total (0 surface, 0 defer, 0 rated)");
    expect(text).toContain("Last run: no runs yet");
    expect(text).not.toContain("memory search is unavailable");
  });

  it("warns when memory is unavailable and shows configured models", async () => {
    const params = makeParams({
      config: normalizeReflectConfig({ scanModel: "anthropic/sonnet-4.6" }),
      memoryAvailable: false,
    });
    const { text } = await handleReflectCommand({ ...params, action: { kind: "status" } });
    expect(text).toContain("Scan model: anthropic/sonnet-4.6");
    expect(text).toContain("Synthesis model: anthropic/sonnet-4.6");
    expect(text).toContain("memory search is unavailable");
  });

  it("reports token spend, insight counts, and the latest run age", async () => {
    const { store } = makeStore({
      insights: [
        makeInsight({ id: "a1", tier: "surface", feedback: "up" }),
        makeInsight({ id: "a2" }),
        makeInsight({ id: "a3" }),
      ],
      runs: [
        makeRun({
          id: "r1",
          outcome: "completed",
          iterations: 2,
          tokens: { input: 300, output: 200, total: 500 },
          startedAt: NOW - 3 * 60_000,
        }),
      ],
      dailyTokens: { "2026-01-15": 1234 },
    });
    const params = makeParams({ store });
    const { text } = await handleReflectCommand({ ...params, action: { kind: "status" } });
    expect(text).toContain("Today's token spend: 1234 / 50000");
    expect(text).toContain("Banked insights: 3 total (1 surface, 2 defer, 1 rated)");
    expect(text).toContain("Last run: completed, 2 iterations, 500 tokens, 3m ago");
  });

  it("humanizes older run ages as hours and days", async () => {
    const hoursAgo = makeRun({ id: "r1", startedAt: NOW - 2 * 3_600_000 });
    const { store } = makeStore({ runs: [hoursAgo] });
    const params = makeParams({ store });
    const { text } = await handleReflectCommand({ ...params, action: { kind: "status" } });
    expect(text).toContain("2h ago");

    const daysAgo = makeRun({ id: "r2", startedAt: NOW - 5 * 86_400_000 });
    const { store: store2 } = makeStore({ runs: [daysAgo] });
    const { text: text2 } = await handleReflectCommand({
      ...makeParams({ store: store2 }),
      action: { kind: "status" },
    });
    expect(text2).toContain("5d ago");
  });
});

describe("handleReflectCommand digest", () => {
  it("explains shadow mode when nothing is banked", async () => {
    const params = makeParams();
    const { text } = await handleReflectCommand({
      ...params,
      action: { kind: "digest", limit: 10 },
    });
    expect(text).toContain("No banked insights yet.");
    expect(text).toContain("shadow mode");
  });

  it("renders id, score, tier, sources, draft, and rated marker", async () => {
    const { store } = makeStore({
      insights: [
        makeInsight({
          id: "a1",
          tier: "surface",
          score: 92,
          insight: "User prefers concise answers",
          wouldSurfaceText: "d".repeat(250),
          feedback: "up",
          provenance: [
            { path: "memory/p1.md", startLine: 1, endLine: 2, score: 0.9 },
            { path: "memory/p1.md", startLine: 5, endLine: 8, score: 0.8 },
            { path: "memory/p2.md", startLine: 1, endLine: 2, score: 0.7 },
            { path: "memory/p3.md", startLine: 1, endLine: 2, score: 0.6 },
            { path: "memory/p4.md", startLine: 1, endLine: 2, score: 0.5 },
          ],
        }),
        makeInsight({ id: "a2", score: 64, insight: "Second insight" }),
      ],
    });
    const params = makeParams({ store });
    const { text } = await handleReflectCommand({
      ...params,
      action: { kind: "digest", limit: 10 },
    });
    expect(text).toContain("#a1 [92/100 surface] (rated up) User prefers concise answers");
    expect(text).toContain("   sources: memory/p1.md, memory/p2.md, memory/p3.md +1 more");
    expect(text).toContain(`   draft: ${"d".repeat(200)}`);
    expect(text).not.toContain("d".repeat(201));
    expect(text).toContain("#a2 [64/100 defer] Second insight");
    expect(text).not.toContain("#a2 [64/100 defer] (rated");
    expect(text).toContain("Rate: /reflect rate <id> up|down");
  });

  it("passes the limit through to the store", async () => {
    const { store } = makeStore({
      insights: [makeInsight({ id: "a1" }), makeInsight({ id: "a2" }), makeInsight({ id: "a3" })],
    });
    const params = makeParams({ store });
    const { text } = await handleReflectCommand({
      ...params,
      action: { kind: "digest", limit: 2 },
    });
    expect(text).toContain("#a1");
    expect(text).toContain("#a2");
    expect(text).not.toContain("#a3");
  });
});

describe("handleReflectCommand rate", () => {
  it("records feedback for an existing insight", async () => {
    const { store } = makeStore({ insights: [makeInsight({ id: "x1" })] });
    const params = makeParams({ store });
    const { text } = await handleReflectCommand({
      ...params,
      action: { kind: "rate", id: "x1", feedback: "up" },
    });
    expect(text).toContain("Recorded up for #x1.");
    expect((await store.getInsight("x1"))?.feedback).toBe("up");
  });

  it("reports a missing insight", async () => {
    const params = makeParams();
    const { text } = await handleReflectCommand({
      ...params,
      action: { kind: "rate", id: "zz", feedback: "down" },
    });
    expect(text).toContain("No insight #zz found");
  });
});

describe("handleReflectCommand clear", () => {
  it("rejects non-owners without touching the store", async () => {
    const fake = makeStore({ insights: [makeInsight({ id: "a1" })] });
    const params = makeParams({ store: fake.store, senderIsOwner: false });
    const { text } = await handleReflectCommand({ ...params, action: { kind: "clear" } });
    expect(text).toContain("Only the owner can clear the Reflect store.");
    expect(fake.wasCleared()).toBe(false);
  });

  it("clears everything for the owner", async () => {
    const fake = makeStore({ insights: [makeInsight({ id: "a1" })] });
    const params = makeParams({ store: fake.store, senderIsOwner: true });
    const { text } = await handleReflectCommand({ ...params, action: { kind: "clear" } });
    expect(text).toContain("Cleared all banked insights, run summaries, and budget counters.");
    expect(fake.wasCleared()).toBe(true);
  });
});

describe("handleReflectCommand agent scoping", () => {
  it("digest and rate only see the invoking agent's records", async () => {
    const { store } = makeStore({
      insights: [
        makeInsight({ id: "a1", agentId: "main", insight: "Main agent insight" }),
        makeInsight({ id: "b1", agentId: "research", insight: "Research agent insight" }),
      ],
    });
    const params = makeParams({ store, agentId: "research" });
    const { text } = await handleReflectCommand({
      ...params,
      action: { kind: "digest", limit: 10 },
    });
    expect(text).toContain("Research agent insight");
    expect(text).not.toContain("Main agent insight");

    const foreign = await handleReflectCommand({
      ...params,
      action: { kind: "rate", id: "a1", feedback: "up" },
    });
    expect(foreign.text).toContain("No insight #a1 found");

    const own = await handleReflectCommand({
      ...params,
      action: { kind: "rate", id: "b1", feedback: "up" },
    });
    expect(own.text).toContain("Recorded up for #b1");
  });

  it("status counts only the invoking agent's records", async () => {
    const { store } = makeStore({
      insights: [
        makeInsight({ id: "a1", agentId: "main" }),
        makeInsight({ id: "b1", agentId: "research" }),
        makeInsight({ id: "b2", agentId: "research", tier: "surface", score: 90 }),
      ],
    });
    const { text } = await handleReflectCommand({
      ...makeParams({ store, agentId: "research" }),
      action: { kind: "status" },
    });
    expect(text).toContain("Banked insights: 2 total (1 surface, 1 defer, 0 rated)");
  });
});

describe("handleReflectCommand help and unknown", () => {
  it("lists all actions in help", async () => {
    const params = makeParams();
    const { text } = await handleReflectCommand({ ...params, action: { kind: "help" } });
    expect(text).toContain("/reflect status");
    expect(text).toContain("/reflect digest [n]");
    expect(text).toContain("/reflect rate <id> up|down");
    expect(text).toContain("/reflect clear");
  });

  it("prefixes unknown input before the usage block", async () => {
    const params = makeParams();
    const { text } = await handleReflectCommand({
      ...params,
      action: { kind: "unknown", input: "gibberish x" },
    });
    expect(text).toContain("Unknown reflect action: gibberish x");
    expect(text).toContain("/reflect digest [n]");
  });
});
