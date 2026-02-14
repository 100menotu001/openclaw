---
name: compliance
description: "Auto-log agent activity for compliance tracking with configurable destinations"
homepage: https://docs.openclaw.ai/hooks#compliance
metadata:
  {
    "openclaw":
      {
        "emoji": "📋",
        "events": ["agent:bootstrap", "agent:end", "message:received"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Compliance Logging Hook

Automatically logs agent activity for compliance tracking, eliminating the need for agents to manually log their work. Supports multiple destination types for flexible integration.

## Features

- **Zero agent involvement** — Agents can't forget to log; it happens automatically
- **Complete audit trail** — Every agent action has gateway-level evidence
- **Configurable destinations** — Webhook, file, CLI, or telemetry integration
- **Privacy controls** — Optional content redaction for human messages
- **Flexible event filtering** — Choose which events to log

## Events Logged

| Event              | When                              | Example Message                             |
| ------------------ | --------------------------------- | ------------------------------------------- |
| `agent_start`      | Agent session begins              | `Worker - STARTING [telegram]`              |
| `agent_end`        | Agent session completes           | `Worker - COMPLETE [telegram]`              |
| `cron_start`       | Cron job begins                   | `Worker - STARTING: email-check`            |
| `cron_complete`    | Cron job completes                | `Worker - COMPLETE: email-check`            |
| `spawn_start`      | Spawn task dispatched             | `Main - SPAWN: research competitor pricing` |
| `spawn_complete`   | Spawn task completed              | `Worker - SPAWN_COMPLETE: research task`    |
| `dm_sent`          | Agent-to-agent DM sent            | `Main -> QA: please review the patch`       |
| `message_received` | Human message received (optional) | `[telegram] Craig: [redacted]`              |

## Configuration

Enable and configure in `~/.openclaw/openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "compliance": {
          "enabled": true,
          "events": [
            "agent_start",
            "agent_end",
            "cron_start",
            "cron_complete",
            "spawn_start",
            "spawn_complete",
            "dm_sent"
          ],
          "destination": {
            "type": "webhook",
            "url": "https://your-backend.com/api/compliance",
            "headers": {
              "Authorization": "Bearer ${COMPLIANCE_TOKEN}"
            }
          },
          "redactContent": true,
          "debug": false
        }
      }
    }
  }
}
```

## Destination Types

### Webhook

POST events to an HTTP endpoint:

```json
{
  "destination": {
    "type": "webhook",
    "url": "https://your-backend.com/api/compliance",
    "headers": {
      "Authorization": "Bearer your-token"
    },
    "timeoutMs": 5000,
    "batch": true,
    "batchSize": 100,
    "batchFlushMs": 1000
  }
}
```

Events are POSTed as JSON:

```json
{
  "kind": "agent_start",
  "timestamp": "2026-02-04T14:30:00.000Z",
  "agentId": "worker",
  "sessionKey": "agent:worker:main",
  "trigger": "telegram",
  "message": "Worker - STARTING [telegram]"
}
```

### File (JSONL)

Append events to a local file:

```json
{
  "destination": {
    "type": "file",
    "path": "~/.openclaw/logs/compliance.jsonl"
  }
}
```

### CLI

Execute an external command for each event:

```json
{
  "destination": {
    "type": "cli",
    "command": "~/scripts/log-compliance.sh",
    "subcommand": "activity"
  }
}
```

The command receives: `<subcommand> <message> <sessionKey> <activityType>`

### Telemetry Integration

Use the existing telemetry system:

```json
{
  "destination": {
    "type": "telemetry"
  }
}
```

Events are written to `~/.openclaw/logs/telemetry.jsonl` and can be synced via your telemetry sync setup.

## Configuration Options

| Option              | Type     | Default | Description                        |
| ------------------- | -------- | ------- | ---------------------------------- |
| `enabled`           | boolean  | `false` | Enable compliance logging          |
| `events`            | string[] | all     | Which events to log                |
| `destination`       | object   | —       | Where to send events (required)    |
| `includeSessionKey` | boolean  | `true`  | Include session key in events      |
| `redactContent`     | boolean  | `true`  | Redact content in message_received |
| `logFailures`       | boolean  | `true`  | Log failed operations              |
| `debug`             | boolean  | `false` | Log to console for debugging       |

## Event Filtering

Only log specific events:

```json
{
  "events": ["cron_start", "cron_complete"]
}
```

Available events:

- `agent_start` — Agent session begins
- `agent_end` — Agent session completes
- `cron_start` — Cron job begins
- `cron_complete` — Cron job completes
- `spawn_start` — Spawn task dispatched
- `spawn_complete` — Spawn task completed
- `dm_sent` — Agent-to-agent DM sent
- `message_received` — Human message received

## Privacy Considerations

By default, human message content is **redacted**:

```json
{
  "redactContent": true
}
```

Messages appear as:

```
[telegram] Craig: [redacted]
```

To include content (use with caution):

```json
{
  "redactContent": false
}
```

## Use Cases

### Compliance Auditing

Track all agent activity for regulatory compliance:

```json
{
  "destination": {
    "type": "webhook",
    "url": "https://compliance.internal/api/events"
  },
  "events": ["agent_start", "agent_end", "cron_start", "cron_complete"]
}
```

### Debugging

Log everything locally during development:

```json
{
  "destination": {
    "type": "file",
    "path": "~/.openclaw/logs/compliance-debug.jsonl"
  },
  "debug": true
}
```

### Mission Control Integration

Use CLI destination for MC-style logging:

```json
{
  "destination": {
    "type": "cli",
    "command": "~/clawd/mission-control/mc"
  }
}
```

## Disabling

```bash
openclaw hooks disable compliance
```

Or via config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "compliance": { "enabled": false }
      }
    }
  }
}
```

## Integration with Tools

For cron jobs, spawn tasks, and DMs, the compliance system exposes functions that tool implementations can call:

```typescript
import {
  logCronStart,
  logCronComplete,
  logSpawnStart,
  logSpawnComplete,
  logDmSent,
} from "../hooks/bundled/compliance/handler.js";

// In cron job handler
logCronStart(cfg, agentId, jobName, sessionKey);
// ... run job ...
logCronComplete(cfg, agentId, jobName, sessionKey, status);
```

This ensures 100% coverage without modifying the hook system itself.
