// Reflect plugin entry: wires the shadow-mode reflection pipeline to agent_end and /reflect.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/config-runtime";
import { getActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  isSubagentSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "openclaw/plugin-sdk/routing";
import { isAgentAllowed, normalizeReflectConfig } from "./src/config.js";
import { handleReflectCommand, parseReflectCommand } from "./src/digest.js";
import { createReflectDispatcher } from "./src/dispatcher.js";
import { createReflectInsightStore } from "./src/insight-store.js";
import { runReflectionPass } from "./src/pipeline.js";
import { createSessionCursorTracker } from "./src/turn-extract.js";
import type {
  ReflectCompleteFn,
  ReflectInsightStore,
  ReflectJob,
  ReflectLogger,
  ReflectSearchFn,
} from "./src/types.js";

const PLUGIN_ID = "reflect";
/** Pre-gate floor: prompts shorter than this are treated as transactional and skipped. */
const PRE_GATE_MIN_PROMPT_CHARS = 12;

function isTestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITEST === "true" || env.VITEST === "1" || env.NODE_ENV === "test";
}

/** Cheap transactional pre-gate; the scan model's empty-array path covers the rest. */
function isTransactionalPrompt(userText: string): boolean {
  const trimmed = userText.trim();
  return trimmed.length < PRE_GATE_MIN_PROMPT_CHARS || trimmed.startsWith("/");
}

/** Whether the operator granted this plugin per-agent completion binding. */
function readAllowAgentIdOverride(cfg: OpenClawConfig | undefined): boolean {
  const entry = cfg?.plugins?.entries?.[PLUGIN_ID];
  return entry?.llm?.allowAgentIdOverride === true;
}

const TOKEN_ESTIMATE_CHARS = 4;

/**
 * Some providers report no usage (for example streaming without usage support);
 * zeros here would silently disable both token budgets, so fall back to a
 * conservative character-based estimate and always bank something.
 */
function resolveUsageTokens(params: {
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  promptChars: number;
  responseText: string;
}): { input: number; output: number; total: number; estimated: boolean } {
  const input = params.usage.inputTokens ?? 0;
  const output = params.usage.outputTokens ?? 0;
  const total = params.usage.totalTokens ?? input + output;
  if (total > 0 || !params.responseText) {
    return { input, output, total, estimated: false };
  }
  const estimatedInput = Math.ceil(params.promptChars / TOKEN_ESTIMATE_CHARS);
  const estimatedOutput = Math.ceil(params.responseText.length / TOKEN_ESTIMATE_CHARS);
  return {
    input: estimatedInput,
    output: estimatedOutput,
    total: estimatedInput + estimatedOutput,
    estimated: true,
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Reflect",
  description:
    "Background reflection pass that banks memory-linked insights from completed turns for shadow-mode review.",
  register(api: OpenClawPluginApi) {
    const logger: ReflectLogger = {
      info: (message) => api.logger.info?.(message),
      warn: (message) => api.logger.warn?.(message),
    };

    const readCurrentConfig = (): OpenClawConfig | undefined => {
      try {
        return (
          (api.runtime.config?.current?.() as OpenClawConfig | undefined) ??
          (api.config as OpenClawConfig | undefined)
        );
      } catch {
        return api.config as OpenClawConfig | undefined;
      }
    };

    const readLiveConfig = () => {
      const livePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        PLUGIN_ID,
        api.pluginConfig,
      );
      return normalizeReflectConfig(livePluginConfig);
    };

    // Store settings are fixed at first use; changing them requires a gateway restart
    // (plugin metadata/config is process-stable by design).
    let store: ReflectInsightStore | undefined;
    const getStore = (): ReflectInsightStore => {
      if (!store) {
        const config = readLiveConfig();
        store = createReflectInsightStore({
          openStore: (options) => api.runtime.state.openKeyedStore(options),
          storeConfig: config.store,
          now: () => Date.now(),
        });
      }
      return store;
    };

    const buildSearch = async (agentId: string): Promise<ReflectSearchFn | undefined> => {
      const cfg = readCurrentConfig();
      if (!cfg) {
        return undefined;
      }
      let manager;
      try {
        ({ manager } = await getActiveMemorySearchManager({ cfg, agentId }));
      } catch {
        return undefined;
      }
      if (!manager) {
        return undefined;
      }
      return async (query, opts) => {
        const hits = await manager.search(query, {
          maxResults: opts.maxResults,
          ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          // Memory-only corpus: session-transcript hits would leak other sessions'
          // content into a background pass that has no session-visibility filtering.
          sources: ["memory"],
        });
        return hits
          .filter((hit) => hit.source === "memory")
          .map((hit) => ({
            path: hit.path,
            startLine: hit.startLine,
            endLine: hit.endLine,
            score: hit.score,
            snippet: hit.snippet,
          }));
      };
    };

    let warnedEstimatedUsage = false;
    const buildComplete = (jobAgentId: string, allowAgentOverride: boolean): ReflectCompleteFn => {
      // Per-agent completion binding requires the operator's explicit
      // plugins.entries.reflect.llm.allowAgentIdOverride grant; without it the
      // hook gate restricts passes to the default agent instead.
      return async (params) => {
        const result = await api.runtime.llm.complete({
          messages: [{ role: "user", content: params.user }],
          systemPrompt: params.system,
          maxTokens: params.maxTokens,
          ...(params.model ? { model: params.model } : {}),
          ...(params.signal ? { signal: params.signal } : {}),
          ...(allowAgentOverride ? { agentId: jobAgentId } : {}),
          purpose: params.purpose,
        });
        const { estimated, ...tokens } = resolveUsageTokens({
          usage: result.usage,
          promptChars: params.system.length + params.user.length,
          responseText: result.text,
        });
        if (estimated && !warnedEstimatedUsage) {
          warnedEstimatedUsage = true;
          logger.warn("reflect: provider reported no token usage; budgets use estimates");
        }
        return { text: result.text, tokens };
      };
    };

    const tracker = createSessionCursorTracker();
    const dispatcher = createReflectDispatcher({
      logger,
      run: async (job: ReflectJob, signal: AbortSignal) => {
        const config = readLiveConfig();
        const search = await buildSearch(job.agentId);
        await runReflectionPass(
          {
            search,
            complete: buildComplete(job.agentId, readAllowAgentIdOverride(readCurrentConfig())),
            store: getStore(),
            now: () => Date.now(),
            logger,
          },
          config,
          job,
          signal,
        );
      },
    });

    api.on("agent_end", (event, ctx) => {
      if (!event.success) {
        return;
      }
      // Only user-originated turns seed reflection. Core also fires agent_end for
      // system runs (heartbeat, cron, pre-compaction "memory" flushes, overflow),
      // and mining that internal traffic would waste budget on non-conversations.
      if (ctx.trigger !== undefined && ctx.trigger !== "user") {
        return;
      }
      // Subagent runs also arrive with trigger "user"; their prompts are
      // agent-generated, so mining them would spend budget on internal traffic.
      if (ctx.sessionKey && isSubagentSessionKey(ctx.sessionKey)) {
        return;
      }
      const agentId = ctx.agentId;
      if (!agentId) {
        return;
      }
      const config = readLiveConfig();
      if (!isAgentAllowed(config, agentId)) {
        return;
      }
      // Completions run under the default agent's model/credentials unless the
      // operator grants llm.allowAgentIdOverride; without the grant, skip other
      // agents' turns so their transcripts never route through a foreign provider.
      const cfg = readCurrentConfig();
      if (agentId !== resolveDefaultAgentId(cfg ?? {}) && !readAllowAgentIdOverride(cfg)) {
        return;
      }
      if (isTestEnvironment() && !config.forceInTests) {
        return;
      }
      const cursorKey = ctx.sessionKey ?? ctx.sessionId;
      if (!cursorKey) {
        return;
      }
      const { userText, assistantText } = tracker.advance(cursorKey, event.messages);
      if (!userText || !assistantText) {
        return;
      }
      if (config.preGate && isTransactionalPrompt(userText)) {
        return;
      }
      dispatcher.enqueue({
        agentId,
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        ...(event.runId ? { runId: event.runId } : {}),
        userText,
        assistantText,
      });
    });

    api.on("message_received", (event) => {
      // A new inbound message supersedes any in-flight reflection for that session.
      if (event.sessionKey) {
        dispatcher.cancelSession(event.sessionKey);
      }
    });

    api.on("session_end", (event) => {
      const cursorKey = event.sessionKey ?? event.sessionId;
      tracker.clear(cursorKey);
      if (event.sessionKey) {
        dispatcher.cancelSession(event.sessionKey);
      }
    });

    api.lifecycle.registerRuntimeLifecycle({
      id: "reflect-dispatcher",
      description: "Aborts in-flight reflection passes and drains the queue.",
      cleanup: async () => {
        await dispatcher.shutdown();
      },
    });

    api.registerCommand({
      name: "reflect",
      description: "Review shadow-mode reflection insights: status, digest [n], rate <id> up|down.",
      acceptsArgs: true,
      exposeSenderIsOwner: true,
      handler: async (ctx) => {
        const config = readLiveConfig();
        const commandStore = getStore();
        // Non-agent-shaped session keys (gateway/control-plane callers) scope to
        // the configured default agent, matching where the hook banks insights.
        const agentId = parseAgentSessionKey(ctx.sessionKey)
          ? resolveAgentIdFromSessionKey(ctx.sessionKey)
          : resolveDefaultAgentId(readCurrentConfig() ?? {});
        const [lastRun] = await commandStore.listRunSummaries({ limit: 1, agentId });
        const action = parseReflectCommand(ctx.args);
        return await handleReflectCommand({
          action,
          store: commandStore,
          config,
          agentId,
          ...(ctx.senderIsOwner !== undefined ? { senderIsOwner: ctx.senderIsOwner } : {}),
          now: () => Date.now(),
          memoryAvailable: lastRun ? lastRun.outcome !== "no-memory" : true,
        });
      },
    });
  },
});
