import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import { createReflectInsightStore, similarity } from "./insight-store.js";
import type { ReflectConfig, ReflectInsightInput, ReflectRunSummary } from "./types.js";

type FakeRow<T> = { value: T; createdAt: number };

// Mirrors plugin-state-store.sqlite.ts semantics: register upserts and refreshes
// the row's write time, then evicts oldest-write rows (protecting the written
// key) once the namespace exceeds maxEntries. Overflow evicts, it never throws.
function createFakeKeyedStore<T>(options: {
  maxEntries: number;
  withUpdate: boolean;
}): PluginStateKeyedStore<T> {
  const rows = new Map<string, FakeRow<T>>();
  let writeSeq = 0;

  const evictPast = (protectedKey: string) => {
    while (rows.size > options.maxEntries) {
      const oldest = [...rows.entries()]
        .filter(([key]) => key !== protectedKey)
        .toSorted((a, b) => a[1].createdAt - b[1].createdAt || a[0].localeCompare(b[0]))[0];
      if (!oldest) {
        return;
      }
      rows.delete(oldest[0]);
    }
  };
  const write = (key: string, value: T) => {
    rows.set(key, { value, createdAt: ++writeSeq });
    evictPast(key);
  };

  const store: PluginStateKeyedStore<T> = {
    async register(key, value) {
      write(key, value);
    },
    async registerIfAbsent(key, value) {
      if (rows.has(key)) {
        return false;
      }
      write(key, value);
      return true;
    },
    async lookup(key) {
      return rows.get(key)?.value;
    },
    async consume(key) {
      const value = rows.get(key)?.value;
      rows.delete(key);
      return value;
    },
    async delete(key) {
      return rows.delete(key);
    },
    async entries() {
      return [...rows.entries()]
        .toSorted((a, b) => a[1].createdAt - b[1].createdAt)
        .map(
          ([key, row]): PluginStateEntry<T> => ({
            key,
            value: row.value,
            createdAt: row.createdAt,
          }),
        );
    },
    async clear() {
      rows.clear();
    },
  };
  if (options.withUpdate) {
    store.update = async (key, updateValue) => {
      const next = updateValue(rows.get(key)?.value);
      if (next === undefined) {
        return false;
      }
      write(key, next);
      return true;
    };
  }
  return store;
}

function createHarness(
  params: { maxEntries?: number; dedupeSimilarity?: number; withUpdate?: boolean } = {},
) {
  const openedOptions: Array<{ namespace: string; maxEntries: number; defaultTtlMs?: number }> = [];
  const namespaces = new Map<string, PluginStateKeyedStore<unknown>>();
  let clock = 1_000;
  const storeConfig: ReflectConfig["store"] = {
    maxEntries: params.maxEntries ?? 50,
    ttlDays: 90,
    dedupeSimilarity: params.dedupeSimilarity ?? 0.9,
  };
  const store = createReflectInsightStore({
    openStore: <T>(options: { namespace: string; maxEntries: number; defaultTtlMs?: number }) => {
      openedOptions.push(options);
      let fake = namespaces.get(options.namespace);
      if (!fake) {
        fake = createFakeKeyedStore<unknown>({
          maxEntries: options.maxEntries,
          withUpdate: params.withUpdate ?? true,
        });
        namespaces.set(options.namespace, fake);
      }
      return fake as PluginStateKeyedStore<T>;
    },
    storeConfig,
    now: () => ++clock,
  });
  return { store, openedOptions };
}

function makeInput(overrides: Partial<ReflectInsightInput> = {}): ReflectInsightInput {
  return {
    agentId: "main",
    tier: "defer",
    score: 70,
    novelty: 70,
    relevance: 70,
    actionability: 70,
    insight: "user prefers concise answers",
    provenance: [],
    promptPreview: "original prompt",
    ...overrides,
  };
}

function makeRun(id: string, startedAt: number): ReflectRunSummary {
  return {
    id,
    agentId: "main",
    startedAt,
    durationMs: 5,
    iterations: 1,
    outcome: "completed",
    tokens: { input: 10, output: 5, total: 15 },
    candidates: [],
    storedInsightIds: [],
  };
}

describe("similarity", () => {
  it.each<[string, string, string, number]>([
    ["identical", "alpha beta gamma", "alpha beta gamma", 1],
    ["case and punctuation ignored", "Alpha, Beta! Gamma?", "alpha beta gamma", 1],
    ["disjoint", "alpha beta", "gamma delta", 0],
    ["both empty", "", "", 1],
    ["punctuation-only counts as empty", "?!.", "", 1],
    ["one empty", "", "alpha beta", 0],
    ["partial overlap", "alpha beta gamma", "alpha beta delta", 0.5],
    ["duplicate tokens deduped", "alpha alpha beta", "alpha beta", 1],
  ])("%s", (_name, a, b, expected) => {
    expect(similarity(a, b)).toBeCloseTo(expected, 10);
    expect(similarity(b, a)).toBeCloseTo(expected, 10);
  });
});

describe("addInsight", () => {
  it("inserts a fresh record with an 8-hex id and zero dedupeCount", async () => {
    const { store } = createHarness();
    const result = await store.addInsight(makeInput());
    expect(result.deduped).toBe(false);
    expect(result.id).toMatch(/^[0-9a-f]{8}$/);
    const record = await store.getInsight(result.id);
    expect(record).toMatchObject({
      id: result.id,
      dedupeCount: 0,
      insight: "user prefers concise answers",
    });
    expect(record?.createdAt).toBe(record?.updatedAt);
  });

  it("merges a near-duplicate for the same agent and keeps the higher-scored content", async () => {
    const { store } = createHarness();
    const first = await store.addInsight(
      makeInput({ score: 70, wouldSurfaceText: "old follow-up" }),
    );
    const merged = await store.addInsight(
      makeInput({
        score: 90,
        tier: "surface",
        insight: "User prefers concise answers!",
        wouldSurfaceText: "new follow-up",
        promptPreview: "second prompt",
      }),
    );
    expect(merged).toEqual({ id: first.id, deduped: true });
    const record = await store.getInsight(first.id);
    expect(record).toMatchObject({
      score: 90,
      tier: "surface",
      insight: "User prefers concise answers!",
      wouldSurfaceText: "new follow-up",
      dedupeCount: 1,
      promptPreview: "original prompt",
    });
    expect(record && record.updatedAt > record.createdAt).toBe(true);
    expect(await store.listInsights()).toHaveLength(1);
  });

  it("keeps existing content when the incoming duplicate scores lower", async () => {
    const { store } = createHarness();
    const first = await store.addInsight(makeInput({ score: 80 }));
    const merged = await store.addInsight(
      makeInput({ score: 40, insight: "USER PREFERS CONCISE ANSWERS" }),
    );
    expect(merged).toEqual({ id: first.id, deduped: true });
    const record = await store.getInsight(first.id);
    expect(record).toMatchObject({
      score: 80,
      insight: "user prefers concise answers",
      dedupeCount: 1,
    });
  });

  it("upgrades tier to surface when the existing record is surface", async () => {
    const { store } = createHarness();
    const first = await store.addInsight(makeInput({ tier: "surface", score: 90 }));
    await store.addInsight(makeInput({ tier: "defer", score: 40 }));
    expect((await store.getInsight(first.id))?.tier).toBe("surface");
  });

  it("preserves feedback across a merge", async () => {
    const { store } = createHarness();
    const first = await store.addInsight(makeInput());
    expect(await store.rateInsight(first.id, "up")).toBe(true);
    const rated = await store.getInsight(first.id);
    await store.addInsight(makeInput({ score: 95 }));
    const record = await store.getInsight(first.id);
    expect(record?.feedback).toBe("up");
    expect(record?.feedbackAt).toBe(rated?.feedbackAt);
  });

  it("does not merge the same text across different agents", async () => {
    const { store } = createHarness();
    const first = await store.addInsight(makeInput({ agentId: "main" }));
    const second = await store.addInsight(makeInput({ agentId: "other" }));
    expect(second.deduped).toBe(false);
    expect(second.id).not.toBe(first.id);
    expect(await store.listInsights()).toHaveLength(2);
  });

  it("evicts the oldest-updated record when maxEntries is exceeded", async () => {
    const { store } = createHarness({ maxEntries: 2 });
    const first = await store.addInsight(makeInput({ insight: "alpha topic" }));
    const second = await store.addInsight(makeInput({ insight: "beta subject" }));
    const third = await store.addInsight(makeInput({ insight: "gamma theme" }));
    const insights = await store.listInsights();
    expect(insights.map((record) => record.id)).toEqual([third.id, second.id]);
    expect(await store.getInsight(first.id)).toBeUndefined();
  });
});

describe("listInsights", () => {
  it("sorts by updatedAt desc and applies limit", async () => {
    const { store } = createHarness();
    const a = await store.addInsight(makeInput({ insight: "alpha topic" }));
    const b = await store.addInsight(makeInput({ insight: "beta subject" }));
    const c = await store.addInsight(makeInput({ insight: "gamma theme" }));
    expect((await store.listInsights()).map((record) => record.id)).toEqual([c.id, b.id, a.id]);
    // Merging refreshes updatedAt, moving the record to the front.
    await store.addInsight(makeInput({ insight: "alpha, topic." }));
    expect((await store.listInsights({ limit: 2 })).map((record) => record.id)).toEqual([
      a.id,
      c.id,
    ]);
  });
});

describe("rateInsight", () => {
  it.each<[string, boolean]>([
    ["with update()", true],
    ["without update()", false],
  ])("%s sets feedback and reports missing ids", async (_name, withUpdate) => {
    const { store } = createHarness({ withUpdate });
    const { id } = await store.addInsight(makeInput());
    expect(await store.rateInsight(id, "down")).toBe(true);
    const record = await store.getInsight(id);
    expect(record?.feedback).toBe("down");
    expect(typeof record?.feedbackAt).toBe("number");
    expect(await store.rateInsight("deadbeef", "up")).toBe(false);
  });
});

describe("merge draft preservation", () => {
  it("keeps the banked draft when the higher-scoring duplicate arrives without one", async () => {
    const { store } = createHarness();
    const first = await store.addInsight(
      makeInput({
        insight: "Migration conflicts with the recorded Q3 freeze decision",
        tier: "surface",
        score: 88,
        wouldSurfaceText: "This may connect to the Q3 freeze decision.",
      }),
    );
    // Rediscovered with a higher score but no draft (synthesis was budget-skipped).
    const merged = await store.addInsight(
      makeInput({
        insight: "Migration conflicts with the recorded Q3 freeze decision",
        tier: "surface",
        score: 95,
      }),
    );
    expect(merged).toEqual({ id: first.id, deduped: true });
    const record = await store.getInsight(first.id);
    expect(record?.score).toBe(95);
    expect(record?.wouldSurfaceText).toBe("This may connect to the Q3 freeze decision.");
  });
});

describe("run summaries", () => {
  it("lists summaries sorted by startedAt desc with limit", async () => {
    const { store } = createHarness();
    await store.addRunSummary(makeRun("run-a", 100));
    await store.addRunSummary(makeRun("run-c", 300));
    await store.addRunSummary(makeRun("run-b", 200));
    expect((await store.listRunSummaries()).map((run) => run.id)).toEqual([
      "run-c",
      "run-b",
      "run-a",
    ]);
    expect((await store.listRunSummaries({ limit: 1 })).map((run) => run.id)).toEqual(["run-c"]);
  });
});

describe("daily tokens", () => {
  it.each<[string, boolean]>([
    ["with update()", true],
    ["without update()", false],
  ])("%s accumulates per day and reads missing days as 0", async (_name, withUpdate) => {
    const { store } = createHarness({ withUpdate });
    expect(await store.addDailyTokens("2026-07-03", 100)).toBe(100);
    expect(await store.addDailyTokens("2026-07-03", 50)).toBe(150);
    expect(await store.getDailyTokens("2026-07-03")).toBe(150);
    expect(await store.getDailyTokens("2026-07-04")).toBe(0);
  });
});

describe("clearAll", () => {
  it("empties insights, runs, and budget namespaces", async () => {
    const { store } = createHarness();
    await store.addInsight(makeInput());
    await store.addRunSummary(makeRun("run-a", 100));
    await store.addDailyTokens("2026-07-03", 25);
    await store.clearAll();
    expect(await store.listInsights()).toEqual([]);
    expect(await store.listRunSummaries()).toEqual([]);
    expect(await store.getDailyTokens("2026-07-03")).toBe(0);
  });
});

describe("namespace wiring", () => {
  it("opens each namespace lazily once with the configured limits", async () => {
    const { store, openedOptions } = createHarness({ maxEntries: 123 });
    expect(openedOptions).toEqual([]);
    await store.addInsight(makeInput());
    await store.addInsight(makeInput({ insight: "different beta subject" }));
    await store.addRunSummary(makeRun("run-a", 100));
    await store.addDailyTokens("2026-07-03", 10);
    await store.getDailyTokens("2026-07-03");
    expect(openedOptions).toEqual([
      { namespace: "insights", maxEntries: 123, defaultTtlMs: 90 * 86_400_000 },
      { namespace: "runs", maxEntries: 200, defaultTtlMs: 14 * 86_400_000 },
      { namespace: "budget", maxEntries: 16, defaultTtlMs: 3 * 86_400_000 },
    ]);
  });
});
