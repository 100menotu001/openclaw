// Reflect entry wiring tests: agent_end gating, dispatch-to-pipeline flow, and /reflect command.
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import reflectEntry from "./index.js";

const memoryHostSearchMock = vi.hoisted(() => ({
  getActiveMemorySearchManager: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/memory-host-search", () => memoryHostSearchMock);

type StoredEntry = { key: string; value: unknown; createdAt: number };

function createFakeKeyedStore() {
  const entries = new Map<string, StoredEntry>();
  return {
    async register(key: string, value: unknown) {
      entries.set(key, { key, value, createdAt: Date.now() });
    },
    async registerIfAbsent(key: string, value: unknown) {
      if (entries.has(key)) {
        return false;
      }
      entries.set(key, { key, value, createdAt: Date.now() });
      return true;
    },
    async update(key: string, updateValue: (current: unknown) => unknown) {
      const next = updateValue(entries.get(key)?.value);
      if (next === undefined) {
        return false;
      }
      entries.set(key, { key, value: next, createdAt: Date.now() });
      return true;
    },
    async lookup(key: string) {
      return entries.get(key)?.value;
    },
    async consume(key: string) {
      const value = entries.get(key)?.value;
      entries.delete(key);
      return value;
    },
    async delete(key: string) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries.values()];
    },
    async clear() {
      entries.clear();
    },
    raw: entries,
  };
}

const SCAN_JSON = JSON.stringify([
  {
    insight: "This migration conflicts with the Q3 change-freeze decision recorded in memory.",
    novelty: 90,
    relevance: 92,
    actionability: 88,
    sources: [0],
  },
]);

function createHarness(options?: {
  pluginConfig?: Record<string, unknown>;
  manager?: { search: ReturnType<typeof vi.fn> } | null;
  usage?: Record<string, number>;
}) {
  const pluginConfig = options?.pluginConfig ?? { forceInTests: true };
  const config = {
    plugins: { entries: { reflect: { enabled: true, config: pluginConfig } } },
  };
  const namespaces = new Map<string, ReturnType<typeof createFakeKeyedStore>>();
  const complete = vi.fn(async (params: { purpose?: string }) => ({
    text: params.purpose === "reflect-synthesis" ? "This may connect to the Q3 freeze." : SCAN_JSON,
    provider: "test",
    model: "test/model",
    agentId: "main",
    usage: options?.usage ?? { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    audit: { caller: { kind: "plugin" as const } },
  }));
  const searchFn = vi.fn(async () => [
    {
      path: "memory/decisions.md",
      startLine: 1,
      endLine: 12,
      score: 0.91,
      snippet: "Q3 change freeze: no infrastructure migrations before October.",
      source: "memory" as const,
    },
  ]);
  const manager = options?.manager === undefined ? { search: searchFn } : options.manager;
  memoryHostSearchMock.getActiveMemorySearchManager.mockResolvedValue({ manager });

  const hooks = new Map<string, (event: never, ctx: never) => unknown>();
  let command: OpenClawPluginCommandDefinition | undefined;
  const lifecycles: PluginRuntimeLifecycleRegistration[] = [];

  const api = createTestPluginApi({
    id: "reflect",
    pluginConfig,
    config: config as OpenClawPluginApi["config"],
    on: ((hookName: string, handler: (event: never, ctx: never) => unknown) => {
      hooks.set(hookName, handler);
    }) as OpenClawPluginApi["on"],
    registerCommand: (definition) => {
      command = definition;
    },
    registerRuntimeLifecycle: (lifecycle) => {
      lifecycles.push(lifecycle);
    },
    runtime: {
      config: { current: () => config },
      state: {
        openKeyedStore: (opts: { namespace: string }) => {
          let store = namespaces.get(opts.namespace);
          if (!store) {
            store = createFakeKeyedStore();
            namespaces.set(opts.namespace, store);
          }
          return store;
        },
      },
      llm: { complete },
    } as unknown as OpenClawPluginApi["runtime"],
  });
  reflectEntry.register(api);

  const fireAgentEnd = (overrides?: {
    success?: boolean;
    trigger?: string;
    agentId?: string;
    userText?: string;
    sessionKey?: string;
  }) => {
    const handler = hooks.get("agent_end");
    if (!handler) {
      throw new Error("agent_end hook not registered");
    }
    const userText =
      overrides?.userText ?? "Should we migrate the billing service to the new queue this month?";
    (handler as (event: unknown, ctx: unknown) => void)(
      {
        runId: "run-1",
        success: overrides?.success ?? true,
        messages: [
          { role: "user", content: userText },
          { role: "assistant", content: "Yes, the new queue is ready; migrate incrementally." },
        ],
      },
      {
        agentId: overrides?.agentId ?? "main",
        sessionKey: overrides?.sessionKey ?? "agent:main:main",
        ...(overrides?.trigger ? { trigger: overrides.trigger } : {}),
      },
    );
  };

  return { api, hooks, namespaces, complete, searchFn, fireAgentEnd, getCommand: () => command };
}

async function insightCount(
  namespaces: Map<string, ReturnType<typeof createFakeKeyedStore>>,
): Promise<number> {
  return namespaces.get("insights")?.raw.size ?? 0;
}

describe("reflect entry", () => {
  it("registers hooks, command, and lifecycle cleanup", () => {
    const harness = createHarness();
    expect([...harness.hooks.keys()]).toEqual(
      expect.arrayContaining(["agent_end", "message_received", "session_end"]),
    );
    expect(harness.getCommand()?.name).toBe("reflect");
  });

  it("runs the pipeline after an eligible turn and banks records", async () => {
    const harness = createHarness();
    harness.fireAgentEnd();
    await vi.waitFor(async () => {
      expect(await insightCount(harness.namespaces)).toBeGreaterThan(0);
    });
    const purposes = harness.complete.mock.calls.map(
      (call) => (call[0] as { purpose?: string }).purpose,
    );
    expect(purposes).toContain("reflect-scan");
    expect(purposes).toContain("reflect-synthesis");
    expect(harness.namespaces.get("runs")?.raw.size).toBe(1);
    expect(harness.namespaces.get("budget")?.raw.size).toBe(1);
  });

  it("skips turns under the test-environment guard without forceInTests", async () => {
    const harness = createHarness({ pluginConfig: {} });
    harness.fireAgentEnd();
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(harness.complete).not.toHaveBeenCalled();
    expect(await insightCount(harness.namespaces)).toBe(0);
  });

  it.each([
    ["failed turn", { success: false }],
    ["heartbeat trigger", { trigger: "heartbeat" }],
    ["cron trigger", { trigger: "cron" }],
    ["memory flush trigger", { trigger: "memory" }],
    ["overflow trigger", { trigger: "overflow" }],
    ["subagent session", { trigger: "user", sessionKey: "agent:main:subagent:1f2e3d4c" }],
    ["disallowed agent", { agentId: "other" }],
    ["transactional prompt", { userText: "/status" }],
    ["short prompt", { userText: "thanks" }],
  ] as const)("skips ineligible turns: %s", async (_label, overrides) => {
    const harness = createHarness({
      pluginConfig: { forceInTests: true, agents: ["main"] },
    });
    harness.fireAgentEnd(overrides);
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("records a no-memory run when the search manager is unavailable", async () => {
    const harness = createHarness({ manager: null });
    harness.fireAgentEnd();
    await vi.waitFor(() => {
      expect(harness.namespaces.get("runs")?.raw.size).toBe(1);
    });
    const [run] = [...(harness.namespaces.get("runs")?.raw.values() ?? [])];
    expect((run?.value as { outcome?: string } | undefined)?.outcome).toBe("no-memory");
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("skips non-default agents unless the operator grants allowAgentIdOverride", async () => {
    // No agents allowlist: the turn passes isAgentAllowed but must still be
    // gated because completions would run under the default agent's auth.
    const harness = createHarness({ pluginConfig: { forceInTests: true } });
    harness.fireAgentEnd({ agentId: "research" });
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("banks estimated tokens when the provider reports no usage", async () => {
    const harness = createHarness({ usage: {} });
    harness.fireAgentEnd();
    await vi.waitFor(async () => {
      expect(await insightCount(harness.namespaces)).toBeGreaterThan(0);
    });
    const budget = harness.namespaces.get("budget");
    const [entry] = [...(budget?.raw.values() ?? [])];
    expect(entry?.value as number).toBeGreaterThan(0);
  });

  it("serves /reflect status and digest from the banked store", async () => {
    const harness = createHarness();
    harness.fireAgentEnd();
    await vi.waitFor(async () => {
      expect(await insightCount(harness.namespaces)).toBeGreaterThan(0);
    });
    const command = harness.getCommand();
    if (!command) {
      throw new Error("command not registered");
    }
    const status = await command.handler({
      args: "status",
      commandBody: "/reflect status",
    } as never);
    expect(status.text).toContain("Reflect");
    expect(status.text).toContain("shadow");
    const digest = await command.handler({
      args: "digest",
      commandBody: "/reflect digest",
    } as never);
    expect(digest.text).toContain("Q3 change-freeze");
    expect(digest.text).toContain("memory/decisions.md");
  });
});
