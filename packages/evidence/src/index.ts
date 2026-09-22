/**
 * @rubric/evidence — offline evidence export (tasks/P5.md).
 *
 * Assembles a JSON evidence bundle (DARs, proofs, anchor refs, continuity
 * report, schema-change log) plus a plain-text summary, reading the SQLite index
 * shards and bundle store directly (no network). Exposed as the CLI
 * `rubric-evidence export`.
 */
export { exportEvidence, type ExportResult } from "./export.js";
export { assembleEvidence, buildSchemaChangeLog, type AssembleOptions } from "./bundle.js";
export { renderSummary } from "./summary.js";
export { openIndexReader, openStoreReader } from "./adapters.js";
export type {
  EvidenceBundle,
  EvidenceIndex,
  StorePort,
  DecisionEvidence,
  SchemaEpoch,
  ContinuityReport,
  IndexRow,
  VerifiableBundle,
} from "./ports.js";
