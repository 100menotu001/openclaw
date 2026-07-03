// Normalizes plugins.entries.reflect.config into ReflectConfig with bounded defaults.
import type { ReflectConfig } from "./types.js";

export const REFLECT_DEFAULTS = {
  preGate: true,
  surfaceThreshold: 85,
  deferThreshold: 60,
  maxIterations: 3,
  stallIterations: 2,
  loopTokenBudget: 15_000,
  timeoutSeconds: 120,
  dailyTokenBudget: 50_000,
  storeMaxEntries: 400,
  storeTtlDays: 90,
  dedupeSimilarity: 0.9,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: string[] = [];
  for (const entry of value) {
    const normalized = readString(entry);
    if (normalized && !items.includes(normalized)) {
      items.push(normalized);
    }
  }
  return items;
}

/** Applies defaults and bounds to the raw plugin config object. Never throws. */
export function normalizeReflectConfig(raw: unknown): ReflectConfig {
  const root = isRecord(raw) ? raw : {};
  const triage = isRecord(root.triage) ? root.triage : {};
  const convergence = isRecord(root.convergence) ? root.convergence : {};
  const store = isRecord(root.store) ? root.store : {};

  const deferThreshold = readBoundedInt(
    triage.deferThreshold,
    REFLECT_DEFAULTS.deferThreshold,
    0,
    100,
  );
  // Surface can never sit below defer: an inverted pair would route every banked
  // insight to the surface tier and defeat the anti-noise design.
  const surfaceThreshold = Math.max(
    deferThreshold,
    readBoundedInt(triage.surfaceThreshold, REFLECT_DEFAULTS.surfaceThreshold, 0, 100),
  );

  const scanModel = readString(root.scanModel);
  const synthesisModel = readString(root.synthesisModel) ?? scanModel;

  return {
    agents: readStringList(root.agents),
    ...(scanModel ? { scanModel } : {}),
    ...(synthesisModel ? { synthesisModel } : {}),
    preGate: readBoolean(root.preGate, REFLECT_DEFAULTS.preGate),
    triage: { surfaceThreshold, deferThreshold },
    convergence: {
      maxIterations: readBoundedInt(
        convergence.maxIterations,
        REFLECT_DEFAULTS.maxIterations,
        1,
        5,
      ),
      stallIterations: readBoundedInt(
        convergence.stallIterations,
        REFLECT_DEFAULTS.stallIterations,
        1,
        3,
      ),
      loopTokenBudget: readBoundedInt(
        convergence.loopTokenBudget,
        REFLECT_DEFAULTS.loopTokenBudget,
        1_000,
        200_000,
      ),
      timeoutSeconds: readBoundedInt(
        convergence.timeoutSeconds,
        REFLECT_DEFAULTS.timeoutSeconds,
        5,
        600,
      ),
    },
    dailyTokenBudget: readBoundedInt(
      root.dailyTokenBudget,
      REFLECT_DEFAULTS.dailyTokenBudget,
      1_000,
      5_000_000,
    ),
    store: {
      maxEntries: readBoundedInt(store.maxEntries, REFLECT_DEFAULTS.storeMaxEntries, 10, 2_000),
      ttlDays: readBoundedInt(store.ttlDays, REFLECT_DEFAULTS.storeTtlDays, 1, 365),
      dedupeSimilarity: readBoundedNumber(
        store.dedupeSimilarity,
        REFLECT_DEFAULTS.dedupeSimilarity,
        0.5,
        1,
      ),
    },
    logging: readBoolean(root.logging, false),
    // Testing-only seam, intentionally absent from the public manifest schema
    // (strict validation rejects it in user config); test harnesses inject it.
    forceInTests: readBoolean(root.forceInTests, false),
  };
}

/** Whether reflection may run for this agent under the configured allowlist. */
export function isAgentAllowed(config: ReflectConfig, agentId: string | undefined): boolean {
  if (config.agents.length === 0) {
    return true;
  }
  return agentId !== undefined && config.agents.includes(agentId);
}

/** UTC day bucket key used for daily token budget accounting. */
export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
