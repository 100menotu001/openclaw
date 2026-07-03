// Shared contracts for the Reflect plugin: insight records, store API, and pipeline dependencies.

/** Triage tier for a banked insight. Discarded candidates are never persisted as records. */
export type ReflectTier = "surface" | "defer";

export type ReflectFeedback = "up" | "down";

/** Memory chunk citation attached to an insight for provenance. */
export type ReflectProvenance = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
};

/** One banked insight. Phase 0 is shadow mode: records exist only for digest review. */
export type ReflectInsightRecord = {
  id: string;
  agentId: string;
  sessionKey?: string;
  tier: ReflectTier;
  /** Composite 0-100 gate score (mean of the three sub-scores, rounded). */
  score: number;
  novelty: number;
  relevance: number;
  actionability: number;
  insight: string;
  /** Drafted would-be follow-up for surface-tier insights. Never delivered in shadow mode. */
  wouldSurfaceText?: string;
  provenance: ReflectProvenance[];
  /** Bounded preview of the originating user prompt. */
  promptPreview: string;
  createdAt: number;
  updatedAt: number;
  /** Number of near-duplicate insights merged into this record. */
  dedupeCount: number;
  feedback?: ReflectFeedback;
  feedbackAt?: number;
};

export type ReflectRunOutcome =
  | "completed"
  | "aborted"
  | "timeout"
  | "budget-exhausted"
  | "no-memory"
  | "error";

/** Per-pass summary logged for shadow-mode tuning: every candidate and score, kept or not. */
export type ReflectRunSummary = {
  id: string;
  agentId: string;
  sessionKey?: string;
  startedAt: number;
  durationMs: number;
  iterations: number;
  outcome: ReflectRunOutcome;
  error?: string;
  tokens: { input: number; output: number; total: number };
  candidates: Array<{ score: number; tier: ReflectTier | "discard"; preview: string }>;
  storedInsightIds: string[];
};

/** Unit of work handed from the agent_end hook to the dispatcher. */
export type ReflectJob = {
  agentId: string;
  sessionKey?: string;
  runId?: string;
  userText: string;
  assistantText: string;
};

export type ReflectInsightInput = Omit<
  ReflectInsightRecord,
  "id" | "createdAt" | "updatedAt" | "dedupeCount" | "feedback" | "feedbackAt"
>;

/** Persistence API backed by the plugin keyed state store (shared SQLite state DB). */
export type ReflectInsightStore = {
  /** Adds an insight, merging into an existing near-duplicate instead when similarity allows. */
  addInsight(input: ReflectInsightInput): Promise<{ id: string; deduped: boolean }>;
  /** Newest-first. `agentId` scopes the listing to one agent's records. */
  listInsights(opts?: { limit?: number; agentId?: string }): Promise<ReflectInsightRecord[]>;
  getInsight(id: string): Promise<ReflectInsightRecord | undefined>;
  /** `agentId` restricts rating to records owned by that agent (missing/foreign ids return false). */
  rateInsight(id: string, feedback: ReflectFeedback, opts?: { agentId?: string }): Promise<boolean>;
  addRunSummary(run: ReflectRunSummary): Promise<void>;
  /** Newest-first. `agentId` scopes the listing to one agent's runs. */
  listRunSummaries(opts?: { limit?: number; agentId?: string }): Promise<ReflectRunSummary[]>;
  /** Atomically adds tokens to a UTC day bucket and returns the new total. */
  addDailyTokens(dayKey: string, tokens: number): Promise<number>;
  getDailyTokens(dayKey: string): Promise<number>;
  clearAll(): Promise<void>;
};

/** Memory hit shape consumed by the pipeline (subset of the SDK MemorySearchResult). */
export type ReflectMemoryHit = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
};

export type ReflectSearchFn = (
  query: string,
  opts: { maxResults: number; minScore?: number; signal?: AbortSignal },
) => Promise<ReflectMemoryHit[]>;

export type ReflectCompletionResult = {
  text: string;
  tokens: { input: number; output: number; total: number };
};

export type ReflectCompleteFn = (params: {
  system: string;
  user: string;
  /** Provider/model ref override; omitted means the agent's configured model. */
  model?: string;
  maxTokens: number;
  signal?: AbortSignal;
  purpose: string;
}) => Promise<ReflectCompletionResult>;

export type ReflectLogger = {
  info(message: string): void;
  warn(message: string): void;
};

/** Injected dependencies for one reflection pass. `search` is undefined when memory is unavailable. */
export type ReflectPipelineDeps = {
  search: ReflectSearchFn | undefined;
  complete: ReflectCompleteFn;
  store: ReflectInsightStore;
  now(): number;
  logger: ReflectLogger;
};

/** Normalized plugin configuration with all defaults applied. */
export type ReflectConfig = {
  /** Agent id allowlist; empty means every agent. */
  agents: string[];
  scanModel?: string;
  synthesisModel?: string;
  preGate: boolean;
  triage: { surfaceThreshold: number; deferThreshold: number };
  convergence: {
    maxIterations: number;
    stallIterations: number;
    loopTokenBudget: number;
    timeoutSeconds: number;
  };
  dailyTokenBudget: number;
  store: { maxEntries: number; ttlDays: number; dedupeSimilarity: number };
  logging: boolean;
  forceInTests: boolean;
};
