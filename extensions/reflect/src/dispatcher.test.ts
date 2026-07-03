import { describe, expect, it } from "vitest";
import { createReflectDispatcher } from "./dispatcher.js";
import type { ReflectJob, ReflectLogger } from "./types.js";

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function job(sessionKey: string, userText = "ask"): ReflectJob {
  return { agentId: "main", sessionKey, userText, assistantText: "reply" };
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createLoggerSpy(): { logger: ReflectLogger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      info: () => {},
      warn: (message) => warnings.push(message),
    },
  };
}

type RunCall = { job: ReflectJob; signal: AbortSignal; gate: Deferred };

function createRunHarness() {
  const calls: RunCall[] = [];
  const run = (runJob: ReflectJob, signal: AbortSignal): Promise<void> => {
    const gate = deferred();
    calls.push({ job: runJob, signal, gate });
    return gate.promise;
  };
  return { calls, run };
}

describe("createReflectDispatcher", () => {
  it("runs a job and settles back to idle", async () => {
    const { calls, run } = createRunHarness();
    const { logger } = createLoggerSpy();
    const dispatcher = createReflectDispatcher({ run, logger });

    dispatcher.enqueue(job("s1"));
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].job.sessionKey).toBe("s1");
    expect(dispatcher.inFlightCount()).toBe(1);
    expect(dispatcher.queuedCount()).toBe(0);

    calls[0].gate.resolve();
    await tick();
    expect(dispatcher.inFlightCount()).toBe(0);
    await dispatcher.shutdown();
  });

  it("replaces a queued same-session job so the superseded turn never runs", async () => {
    const { calls, run } = createRunHarness();
    const { logger } = createLoggerSpy();
    const dispatcher = createReflectDispatcher({ run, logger });

    dispatcher.enqueue(job("s1"));
    await tick();
    dispatcher.enqueue(job("s2", "old turn"));
    dispatcher.enqueue(job("s2", "new turn"));
    expect(dispatcher.queuedCount()).toBe(1);

    calls[0].gate.resolve();
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].job.userText).toBe("new turn");

    calls[1].gate.resolve();
    await dispatcher.shutdown();
  });

  it("aborts the in-flight run when the same session enqueues, then runs the new job", async () => {
    const { calls, run } = createRunHarness();
    const { logger } = createLoggerSpy();
    const dispatcher = createReflectDispatcher({ run, logger });

    dispatcher.enqueue(job("s1", "first"));
    await tick();
    expect(calls[0].signal.aborted).toBe(false);

    dispatcher.enqueue(job("s1", "second"));
    // The in-flight run observes the abort through its own signal.
    expect(calls[0].signal.aborted).toBe(true);
    expect(dispatcher.queuedCount()).toBe(1);

    calls[0].gate.resolve();
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].job.userText).toBe("second");
    expect(calls[1].signal.aborted).toBe(false);

    calls[1].gate.resolve();
    await dispatcher.shutdown();
  });

  it("runs different sessions in FIFO order", async () => {
    const { calls, run } = createRunHarness();
    const { logger } = createLoggerSpy();
    const dispatcher = createReflectDispatcher({ run, logger });

    dispatcher.enqueue(job("s1"));
    dispatcher.enqueue(job("s2"));
    dispatcher.enqueue(job("s3"));
    await tick();
    expect(dispatcher.inFlightCount()).toBe(1);
    expect(dispatcher.queuedCount()).toBe(2);

    for (let index = 0; index < 3; index++) {
      calls[index].gate.resolve();
      await tick();
    }
    expect(calls.map((call) => call.job.sessionKey)).toEqual(["s1", "s2", "s3"]);
    await dispatcher.shutdown();
  });

  it("drops the oldest queued job with a warning on overflow", async () => {
    const { calls, run } = createRunHarness();
    const { logger, warnings } = createLoggerSpy();
    const dispatcher = createReflectDispatcher({ run, logger, maxQueued: 2 });

    dispatcher.enqueue(job("s1"));
    await tick();
    dispatcher.enqueue(job("s2"));
    dispatcher.enqueue(job("s3"));
    dispatcher.enqueue(job("s4"));
    expect(dispatcher.queuedCount()).toBe(2);
    expect(warnings.some((message) => message.includes("s2"))).toBe(true);

    calls[0].gate.resolve();
    await tick();
    calls[1].gate.resolve();
    await tick();
    calls[2].gate.resolve();
    await tick();
    expect(calls.map((call) => call.job.sessionKey)).toEqual(["s1", "s3", "s4"]);
    await dispatcher.shutdown();
  });

  it("cancelSession aborts the matching in-flight run and drops queued jobs", async () => {
    const { calls, run } = createRunHarness();
    const { logger } = createLoggerSpy();
    const dispatcher = createReflectDispatcher({ run, logger });

    dispatcher.enqueue(job("s1"));
    await tick();
    dispatcher.enqueue(job("s2"));

    dispatcher.cancelSession("s1");
    expect(calls[0].signal.aborted).toBe(true);
    expect(dispatcher.queuedCount()).toBe(1);

    dispatcher.cancelSession("s2");
    expect(dispatcher.queuedCount()).toBe(0);

    calls[0].gate.resolve();
    await tick();
    expect(calls).toHaveLength(1);
    expect(dispatcher.inFlightCount()).toBe(0);
    await dispatcher.shutdown();
  });

  it("contains run rejections and keeps processing later jobs", async () => {
    const { calls, run } = createRunHarness();
    const { logger, warnings } = createLoggerSpy();
    const dispatcher = createReflectDispatcher({ run, logger });

    dispatcher.enqueue(job("s1"));
    dispatcher.enqueue(job("s2"));
    await tick();

    calls[0].gate.reject(new Error("pipeline exploded"));
    await tick();
    expect(warnings.some((message) => message.includes("pipeline exploded"))).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].job.sessionKey).toBe("s2");

    calls[1].gate.resolve();
    await dispatcher.shutdown();
  });

  it("shutdown aborts the in-flight run, awaits settlement, and no-ops later enqueues", async () => {
    const { calls, run } = createRunHarness();
    const { logger, warnings } = createLoggerSpy();
    const dispatcher = createReflectDispatcher({ run, logger });

    dispatcher.enqueue(job("s1"));
    await tick();
    dispatcher.enqueue(job("s2"));

    const shutdownPromise = dispatcher.shutdown();
    expect(calls[0].signal.aborted).toBe(true);
    expect(dispatcher.queuedCount()).toBe(0);

    let settled = false;
    void shutdownPromise.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);

    calls[0].gate.resolve();
    await shutdownPromise;
    expect(dispatcher.inFlightCount()).toBe(0);

    dispatcher.enqueue(job("s3"));
    expect(calls).toHaveLength(1);
    expect(dispatcher.queuedCount()).toBe(0);
    expect(warnings.some((message) => message.includes("dropping job"))).toBe(true);

    // Idempotent: a second shutdown resolves immediately.
    await dispatcher.shutdown();
  });
});
