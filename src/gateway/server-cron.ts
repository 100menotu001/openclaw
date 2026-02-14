import type { CliDeps } from "../cli/deps.js";
import type { CronJob } from "../cron/types.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { appendCronRunLog, resolveCronRunLogPath } from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { resolveCronStorePath } from "../cron/store.js";
import { logCronStart, logCronComplete } from "../hooks/bundled/compliance/handler.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";

export type GatewayCronState = {
  cron: CronService;
  storePath: string;
  cronEnabled: boolean;
};

// In-memory cache for job metadata (avoids sync file reads on every event)
const jobMetadataCache = new Map<string, { name: string; agentId?: string }>();

/**
 * Cache job metadata when jobs are created/updated.
 */
export function cacheJobMetadata(job: CronJob): void {
  jobMetadataCache.set(job.id, { name: job.name, agentId: job.agentId });
}

/**
 * Get cached job metadata, with fallback.
 */
function getJobMetadata(jobId: string): { name: string; agentId?: string } {
  return jobMetadataCache.get(jobId) || { name: `job-${jobId.slice(0, 8)}` };
}

/**
 * Clear job from cache when removed.
 */
export function clearJobMetadata(jobId: string): void {
  jobMetadataCache.delete(jobId);
}

// Helper to call legacy cron webhooks (if configured)
async function callWebhook(
  url: string | undefined,
  payload: Record<string, unknown>,
  headers?: Record<string, string>,
  logger?: ReturnType<typeof getChildLogger>,
): Promise<void> {
  if (!url) {
    return;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      logger?.warn({ url, status: response.status }, "cron webhook failed");
    }
  } catch (err) {
    logger?.warn({ url, err: String(err) }, "cron webhook error");
  }
}

export function buildGatewayCronService(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewayCronState {
  const cronLogger = getChildLogger({ module: "cron" });
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const cronEnabled = process.env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = loadConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const hasAgent =
      normalized !== undefined &&
      Array.isArray(runtimeConfig.agents?.list) &&
      runtimeConfig.agents.list.some(
        (entry) =>
          entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized,
      );
    const agentId = hasAgent ? normalized : resolveDefaultAgentId(runtimeConfig);
    return { agentId, cfg: runtimeConfig };
  };

  const cron = new CronService({
    storePath,
    cronEnabled,
    enqueueSystemEvent: (text, opts) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts?.agentId);
      const sessionKey = resolveAgentMainSessionKey({
        cfg: runtimeConfig,
        agentId,
      });
      enqueueSystemEvent(text, { sessionKey });
    },
    requestHeartbeatNow,
    runHeartbeatOnce: async (opts) => {
      const runtimeConfig = loadConfig();
      return await runHeartbeatOnce({
        cfg: runtimeConfig,
        reason: opts?.reason,
        deps: { ...params.deps, runtime: defaultRuntime },
      });
    },
    runIsolatedAgentJob: async ({ job, message }) => {
      // Cache job metadata when running (ensures cache is populated)
      cacheJobMetadata(job);

      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      return await runCronIsolatedAgentTurn({
        cfg: runtimeConfig,
        deps: params.deps,
        job,
        message,
        agentId,
        sessionKey: `cron:${job.id}`,
        lane: "cron",
      });
    },
    log: getChildLogger({ module: "cron", storePath }),
    onEvent: (evt) => {
      params.broadcast("cron", evt, { dropIfSlow: true });

      // Load config ONCE for this event
      const cfg = loadConfig();
      const webhooks = cfg.cron?.webhooks;

      // Get job metadata from cache (no sync file I/O)
      const { name: jobName, agentId } = getJobMetadata(evt.jobId);
      const resolvedAgentId = agentId || resolveDefaultAgentId(cfg);

      if (evt.action === "started") {
        // Legacy cron webhooks (if configured)
        if (webhooks?.onJobStart) {
          void callWebhook(
            webhooks.onJobStart,
            {
              jobId: evt.jobId,
              jobName,
              agentId: resolvedAgentId,
              startedAt: evt.runAtMs || Date.now(),
              timestamp: new Date().toISOString(),
            },
            webhooks.headers,
            cronLogger,
          );
        }

        // Compliance system (if enabled)
        logCronStart(cfg, resolvedAgentId, jobName);
      }

      if (evt.action === "finished") {
        // Legacy cron webhooks (if configured)
        if (webhooks?.onJobComplete) {
          void callWebhook(
            webhooks.onJobComplete,
            {
              jobId: evt.jobId,
              jobName,
              agentId: resolvedAgentId,
              status: evt.status,
              durationMs: evt.durationMs,
              error: evt.error,
              summary: evt.summary,
              completedAt: Date.now(),
              timestamp: new Date().toISOString(),
            },
            webhooks.headers,
            cronLogger,
          );
        }

        // Compliance system (if enabled)
        logCronComplete(cfg, resolvedAgentId, jobName, undefined, evt.status || "ok");

        // Existing run log logic
        const logPath = resolveCronRunLogPath({
          storePath,
          jobId: evt.jobId,
        });
        void appendCronRunLog(logPath, {
          ts: Date.now(),
          jobId: evt.jobId,
          action: "finished",
          status: evt.status,
          error: evt.error,
          summary: evt.summary,
          runAtMs: evt.runAtMs,
          durationMs: evt.durationMs,
          nextRunAtMs: evt.nextRunAtMs,
        }).catch((err) => {
          cronLogger.warn({ err: String(err), logPath }, "cron: run log append failed");
        });
      }

      // Handle cache cleanup on job removal
      if (evt.action === "removed") {
        clearJobMetadata(evt.jobId);
      }
    },
  });

  return { cron, storePath, cronEnabled };
}
