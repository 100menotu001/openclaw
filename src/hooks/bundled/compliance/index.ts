/**
 * Compliance Hook
 *
 * Auto-log agent activity for compliance tracking with configurable destinations.
 *
 * @module hooks/bundled/compliance
 */

// Re-export types
export type {
  ComplianceConfig,
  ComplianceDestination,
  ComplianceEvent,
  ComplianceEventKind,
  ComplianceEmitter,
  WebhookDestination,
  FileDestination,
  CliDestination,
  TelemetryDestination,
} from "./types.js";

export { DEFAULT_COMPLIANCE_CONFIG } from "./types.js";

// Re-export emitter factory
export { createComplianceSystem } from "./emitter.js";

// Re-export handler and convenience functions
export {
  default as handler,
  logCronStart,
  logCronComplete,
  logSpawnStart,
  logSpawnComplete,
  logDmSent,
} from "./handler.js";
