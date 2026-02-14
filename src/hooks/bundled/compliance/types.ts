/**
 * Compliance Plugin Types
 *
 * Defines event types and configuration for the compliance logging plugin.
 */

// =============================================================================
// Compliance Events
// =============================================================================

export type ComplianceEventKind =
  | "agent_start"
  | "agent_end"
  | "cron_start"
  | "cron_complete"
  | "spawn_start"
  | "spawn_complete"
  | "dm_sent"
  | "message_received";

export type ComplianceEvent = {
  /** Event type */
  kind: ComplianceEventKind;
  /** ISO timestamp */
  timestamp: string;
  /** Agent identifier (e.g., "main", "worker", "qa") */
  agentId: string;
  /** Session key (e.g., "agent:worker:main") */
  sessionKey?: string;
  /** What triggered this event (e.g., "telegram", "cron", "spawn") */
  trigger?: string;
  /** Human-readable message */
  message: string;
  /** Event-specific metadata */
  metadata?: Record<string, unknown>;
};

// =============================================================================
// Destination Configuration
// =============================================================================

export type WebhookDestination = {
  type: "webhook";
  /** URL to POST events to */
  url: string;
  /** Optional headers (e.g., Authorization) */
  headers?: Record<string, string>;
  /** Request timeout in ms (default: 5000) */
  timeoutMs?: number;
  /** Batch events before sending (default: false) */
  batch?: boolean;
  /** Max events per batch (default: 100) */
  batchSize?: number;
  /** Max time to wait before flushing batch in ms (default: 1000) */
  batchFlushMs?: number;
};

export type FileDestination = {
  type: "file";
  /** Path to JSONL file (supports ~ and env vars) */
  path: string;
};

export type CliDestination = {
  type: "cli";
  /** Path to CLI script */
  command: string;
  /** Subcommand to use (default: "activity") */
  subcommand?: string;
};

export type TelemetryDestination = {
  type: "telemetry";
  /** Use existing telemetry plugin */
};

export type ComplianceDestination =
  | WebhookDestination
  | FileDestination
  | CliDestination
  | TelemetryDestination;

// =============================================================================
// Plugin Configuration
// =============================================================================

export type ComplianceConfig = {
  /** Enable/disable compliance logging (default: false) */
  enabled?: boolean;

  /** Events to log (default: all) */
  events?: ComplianceEventKind[];

  /** Where to send events */
  destination: ComplianceDestination;

  /** Include agent session key in events (default: true) */
  includeSessionKey?: boolean;

  /** For message_received: redact content (default: true) */
  redactContent?: boolean;

  /** Log failed operations (default: true) */
  logFailures?: boolean;

  /** Debug mode - log to console (default: false) */
  debug?: boolean;
};

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_COMPLIANCE_CONFIG: Partial<ComplianceConfig> = {
  enabled: false,
  events: [
    "agent_start",
    "agent_end",
    "cron_start",
    "cron_complete",
    "spawn_start",
    "spawn_complete",
    "dm_sent",
  ],
  includeSessionKey: true,
  redactContent: true,
  logFailures: true,
  debug: false,
};

// =============================================================================
// Utility Types
// =============================================================================

export type ComplianceEmitter = {
  emit: (event: ComplianceEvent) => Promise<void> | void;
  flush?: () => Promise<void>;
  close?: () => Promise<void>;
};
