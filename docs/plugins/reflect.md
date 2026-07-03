---
summary: "Optional background reflection pass that banks memory-linked insights from completed turns (shadow mode)"
read_when:
  - You want the agent to mine completed turns for connections to your memory store
  - You are enabling or tuning the bundled Reflect plugin
  - You want to review or rate shadow-mode reflection insights
title: "Reflect plugin"
---

The Reflect plugin adds an optional background reflection pass. After an
eligible turn completes, it searches the agent's memory store for connections
the conversation did not ask about — contradictions with prior decisions,
forgotten context, links to other projects — scores each candidate insight,
and banks the survivors with provenance.

This release is **Phase 0 (shadow mode)**: nothing is ever delivered to the
conversation. Insights accumulate silently and you review them on demand with
`/reflect digest`, rating entries up or down to build tuning signal before any
delivery behavior ships.

The primary reply path is untouched: reflection runs detached after the turn,
is cancelled when a new message arrives in the same session, and skips
heartbeat and cron traffic entirely.

## Default state

Reflect is a bundled plugin and is disabled by default. Enable it with:

```bash
openclaw plugins enable reflect
openclaw gateway restart
```

Reflection needs a working memory backend (the `plugins.slots.memory` owner,
`memory-core` by default). When memory is unavailable the pass records a
`no-memory` run and banks nothing. Retrieval is restricted to the `memory`
corpus; session transcripts are never searched.

By default only the **default agent** reflects: completions run under the
default agent's model and credentials, so other agents' turns are skipped
rather than routed through a foreign provider. To reflect on every agent's
turns with per-agent credentials, grant the override:

```json
{
  "plugins": {
    "entries": {
      "reflect": { "llm": { "allowAgentIdOverride": true } }
    }
  }
}
```

## Pipeline

Each eligible turn runs a bounded loop:

1. **Pre-gate.** Short or command-like prompts are skipped outright.
2. **Retrieve.** Embedding/FTS search over the memory store, seeded by the
   prompt on the first iteration and by the source chunks of surviving
   candidates afterwards (never by model-written text, so speculation cannot
   compound).
3. **Scan.** A cheap model proposes at most five candidate insights per
   iteration, each scored 0-100 for novelty, relevance, and actionability.
4. **Converge.** The loop stops on the iteration cap, stalled discovery, the
   per-pass token budget, the wall-clock timeout, or cancellation — whichever
   fires first.
5. **Triage.** Composite score below `triage.deferThreshold` → discarded
   (logged in the run summary only). Between the thresholds → banked as a
   deferred insight. At or above `triage.surfaceThreshold` → banked as a
   surface-tier insight together with a drafted would-be follow-up message.
6. **Bank.** Near-duplicate insights merge instead of accumulating; records
   expire after `store.ttlDays`.

Every pass writes a run summary (outcome, iterations, token usage, and every
candidate score including discards), and daily token spend counts against
`dailyTokenBudget` — each pass is capped to the day's remaining allowance and
skipped once the budget is exhausted. When a provider reports no token usage,
spend is banked from a conservative character-based estimate so the budget
still binds.

## Commands

```
/reflect             # status: models, budget, banked counts, last run
/reflect digest [n]  # newest banked insights with provenance (default 10)
/reflect rate <id> up|down
/reflect clear       # owner only: wipe insights, runs, and budget counters
```

Status, digest, and rate are scoped to the invoking session's agent; a session
can only review and rate its own agent's insights. Clear is owner-only and
wipes every agent's Reflect data.

## Configuration

All options live under `plugins.entries.reflect.config` and are optional:

```json
{
  "plugins": {
    "entries": {
      "reflect": {
        "enabled": true,
        "config": {
          "agents": [],
          "scanModel": "anthropic/claude-haiku-4-5",
          "preGate": true,
          "triage": { "surfaceThreshold": 85, "deferThreshold": 60 },
          "convergence": {
            "maxIterations": 3,
            "stallIterations": 2,
            "loopTokenBudget": 15000,
            "timeoutSeconds": 120
          },
          "dailyTokenBudget": 50000,
          "store": { "maxEntries": 400, "ttlDays": 90, "dedupeSimilarity": 0.9 }
        }
      }
    }
  }
}
```

- `agents` — agent id allowlist; empty means every agent.
- `scanModel` / `synthesisModel` — provider/model refs for candidate discovery
  and follow-up drafting. When omitted, the default agent's configured model is
  used. Setting either requires the plugin LLM override grant:

```json
{
  "plugins": {
    "entries": {
      "reflect": {
        "llm": {
          "allowModelOverride": true,
          "allowedModels": ["anthropic/claude-haiku-4-5"]
        }
      }
    }
  }
}
```

  `allowModelOverride: true` is required; `allowedModels` optionally restricts
  which targets the plugin may request.
- `triage.*` — the two score thresholds. Raising `surfaceThreshold` does not
  destroy mid-value insights; they land in the deferred tier instead.
- `convergence.*` — loop termination: hard iteration cap, consecutive stalled
  iterations before stopping, per-pass token ceiling, wall-clock timeout.
- `dailyTokenBudget` — hard daily cap across all passes.
- `store.*` — banked-record cap, expiry, and the 0.5-1 similarity above which
  a new insight merges into an existing record.

## Privacy and safety

- Memory content is treated as data: the scan prompt never follows
  instructions found in retrieved snippets, and the pass has no tool access.
- Retrieval reads only the `memory` corpus, never session transcripts.
- Every banked insight cites the memory chunks that produced it.
- Reflection tokens are visible per-pass and per-day in `/reflect` status.
