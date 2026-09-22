/**
 * Attestation index schema (tasks/P2.md). One row per attested leaf; the row
 * mirrors the DAR core identity plus the service `attestationId` and a pointer
 * back to the bundle it was derived from (so the index is a cache, and the
 * bundle store remains the source of truth — the index is rebuildable).
 */
import type { DarCore } from "@rubric/attest-decision";

export interface IndexRow {
  attestationId: string;
  decisionId: string;
  agentId: string;
  schemaHash: string;
  decisionHash: string;
  prev: string | null;
  ts: string;
  leafType: string;
  bundlePath: string;
}

/** A stored attestation bundle: the DAR core plus its service `attestationId`. */
export interface AttestationBundle {
  attestationId: string;
  dar: DarCore;
  // Envelope extras (merkleProof, anchorRef, signature, extensions) may also be
  // present in a bundle; they are not indexed here (see spec/dar-0.1.md §6).
  [k: string]: unknown;
}

/** Derive an index row from a bundle and the path it was read from. */
export function rowFromBundle(bundle: AttestationBundle, bundlePath: string): IndexRow {
  const d = bundle.dar;
  return {
    attestationId: bundle.attestationId,
    decisionId: d.decisionId,
    agentId: d.agentId,
    schemaHash: d.schemaHash,
    decisionHash: d.decisionHash,
    prev: d.prev,
    ts: d.ts,
    leafType: d.leafType,
    bundlePath,
  };
}

/** UTC day key (YYYY-MM-DD) that a row's `ts` shards into. */
export function shardKeyForTs(ts: string): string {
  const key = ts.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new Error(`index: cannot derive shard day from ts '${ts}'`);
  }
  return key;
}

export const SHARD_FILE_PREFIX = "attest-";
export const SHARD_FILE_SUFFIX = ".sqlite";

export function shardFileName(dayKey: string): string {
  return `${SHARD_FILE_PREFIX}${dayKey}${SHARD_FILE_SUFFIX}`;
}

/** Extract the day key from a shard file name, or null if it is not a shard. */
export function dayKeyFromFileName(name: string): string | null {
  if (!name.startsWith(SHARD_FILE_PREFIX) || !name.endsWith(SHARD_FILE_SUFFIX)) return null;
  const key = name.slice(SHARD_FILE_PREFIX.length, name.length - SHARD_FILE_SUFFIX.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}

/** DDL. Indexes back the four queries in tasks/P2.md. */
export const DDL = `
CREATE TABLE IF NOT EXISTS attestations (
  attestationId TEXT PRIMARY KEY,
  decisionId    TEXT NOT NULL,
  agentId       TEXT NOT NULL,
  schemaHash    TEXT NOT NULL,
  decisionHash  TEXT NOT NULL,
  prev          TEXT,
  ts            TEXT NOT NULL,
  leafType      TEXT NOT NULL,
  bundlePath    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_decisionId       ON attestations(decisionId);
CREATE INDEX        IF NOT EXISTS ix_agent_ts         ON attestations(agentId, ts, decisionId);
CREATE INDEX        IF NOT EXISTS ix_agent_schema     ON attestations(agentId, schemaHash, ts, decisionId);
CREATE INDEX        IF NOT EXISTS ix_agent_decisionId ON attestations(agentId, decisionId);
CREATE INDEX        IF NOT EXISTS ix_agent_prev       ON attestations(agentId, prev);
`;
