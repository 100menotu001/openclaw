// Single-worker background dispatcher with latest-turn-wins per session: a newer
// turn replaces the queued job for its session and aborts an in-flight run for it.
import type { ReflectJob, ReflectLogger } from "./types.js";

const DEFAULT_MAX_QUEUED = 4;

export type ReflectDispatcher = {
  enqueue(job: ReflectJob): void;
  cancelSession(sessionKey: string): void;
  shutdown(): Promise<void>;
  inFlightCount(): number;
  queuedCount(): number;
};

function jobKey(job: ReflectJob): string {
  return job.sessionKey ?? `agent:${job.agentId}`;
}

export function createReflectDispatcher(opts: {
  run: (job: ReflectJob, signal: AbortSignal) => Promise<void>;
  logger: ReflectLogger;
  maxQueued?: number;
}): ReflectDispatcher {
  const maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED;
  const queue: ReflectJob[] = [];
  let inFlight: { key: string; controller: AbortController } | undefined;
  let workerPromise: Promise<void> | undefined;
  let stopped = false;

  const runWorker = async (): Promise<void> => {
    // shutdown() empties the queue, so the loop drains out without a separate stop flag.
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) {
        break;
      }
      const controller = new AbortController();
      inFlight = { key: jobKey(job), controller };
      try {
        await opts.run(job, controller.signal);
      } catch (error) {
        // Contain pipeline failures here so a rejected run can never surface
        // as an unhandled rejection or stall the worker loop.
        opts.logger.warn(`reflect: run failed: ${String(error).slice(0, 300)}`);
      } finally {
        inFlight = undefined;
      }
    }
    workerPromise = undefined;
  };

  return {
    enqueue(job) {
      if (stopped) {
        opts.logger.warn("reflect: dispatcher stopped; dropping job");
        return;
      }
      const key = jobKey(job);
      // A newer turn obsoletes the in-flight run's snapshot for the same session.
      if (inFlight?.key === key) {
        inFlight.controller.abort();
      }
      const queuedIndex = queue.findIndex((queued) => jobKey(queued) === key);
      if (queuedIndex >= 0) {
        // Latest turn supersedes the queued one; replace in place, never grow.
        queue[queuedIndex] = job;
        return;
      }
      queue.push(job);
      if (queue.length > maxQueued) {
        const dropped = queue.shift();
        if (dropped) {
          opts.logger.warn(`reflect: queue full; dropped oldest job (${jobKey(dropped)})`);
        }
      }
      workerPromise ??= runWorker();
    },
    cancelSession(sessionKey) {
      if (inFlight?.key === sessionKey) {
        inFlight.controller.abort();
      }
      for (let index = queue.length - 1; index >= 0; index--) {
        const queued = queue[index];
        if (queued && jobKey(queued) === sessionKey) {
          queue.splice(index, 1);
        }
      }
    },
    async shutdown() {
      // Idempotent: repeated calls re-abort a settled controller (no-op) and
      // await the same worker settlement.
      stopped = true;
      queue.length = 0;
      inFlight?.controller.abort();
      await workerPromise;
    },
    inFlightCount() {
      return inFlight ? 1 : 0;
    },
    queuedCount() {
      return queue.length;
    },
  };
}
