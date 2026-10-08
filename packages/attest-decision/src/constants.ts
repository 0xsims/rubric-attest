/**
 * Frozen DAR/0.1 constants and types (spec/dar-0.1.md §2, §4).
 */

/** Record format tag for the frozen DAR/0.1 field set. */
export const DAR_VERSION = "DAR/0.1" as const;

/** Hash algorithm invariant (spec §4.1). SHA3-256 everywhere. */
export const HASH_ALGORITHM = "sha3-256" as const;

/** Prefix on hash-valued fields (spec §4.2), i.e. `sha3-256:`. */
export const HASH_PREFIX = `${HASH_ALGORITHM}:` as const;

/** Attestation endpoint. Test + standard traffic both flush here (CLAUDE.md). */
export const TIERED_ATTEST_PATH = "/v1/tiered-attest" as const;

/** The single credential env var the SDK reads (CLAUDE.md invariant). */
export const API_KEY_ENV = "RUBRIC_API_KEY" as const;

/** SDK name, as sent in the version header. */
export const SDK_NAME = "attest-decision" as const;

/**
 * This package's version. Must equal `version` in package.json (a test fails
 * otherwise). It is a literal rather than a runtime read of package.json because
 * src/ is also consumed verbatim as CommonJS (rubric-protocol's test shim), where
 * neither `import.meta` nor a path relative to this file reaches package.json.
 */
export const SDK_VERSION = "1.2.0" as const;

/** Header carrying `attest-decision/<version>` on every batch POST; the server needs >= 1.2.0. */
export const SDK_VERSION_HEADER = "x-rubric-sdk" as const;

/** A batch-ingest namespace: a random public id the server mints onto an API key. */
export const NAMESPACE_RE = /^ns_[0-9a-f]{12}$/;

/** The agentId charset/length the server's batch ingest accepts (full id, prefix included). */
export const AGENT_ID_RE = /^[A-Za-z0-9._:/@-]{1,200}$/;

/** Rubric's own agent ids: `rubric` alone or followed by a separator, any case. */
export const RESERVED_AGENT_ID_RE = /^rubric([:/_.@-]|$)/i;

/** Leaf discriminant values (spec §2, `leafType`). */
export type LeafType = "decision" | "schema-change" | "checkpoint";

/** A `sha3-256:<hex>` encoded hash string. */
export type HashString = `${typeof HASH_ALGORITHM}:${string}`;

/** Identifies the adapter that produced a decision's inputs (spec §2). */
export interface AdapterInfo {
  readonly name: string;
  readonly version: string;
}

/** Transmit mode: `hash-only` (default) sends DAR cores; `payload` also carries raw content in the envelope. */
export type TransmitMode = "hash-only" | "payload";

/** Raw content transmitted ONLY in `payload` mode, in the transport envelope — never in the DAR core. */
export interface PayloadRecord {
  decisionId: string;
  schema?: unknown;
  input: unknown;
  output: unknown;
  meta?: unknown;
}

/**
 * The DAR core: the frozen, HASHES-ONLY field set (spec §2). It never carries
 * raw content — only commitments. The Merkle leaf hash is computed over the JCS
 * canonicalization of this object.
 */
export interface DarCore {
  readonly v: typeof DAR_VERSION;
  readonly decisionId: string;
  readonly agentId: string;
  /** Client-claimed decision time; trusted time is the HCS consensus timestamp. */
  readonly ts: string;
  readonly prev: string | null;
  readonly leafType: LeafType;
  readonly schemaHash: HashString;
  readonly inputHash: HashString;
  readonly outputHash: HashString;
  /** SHA3-256 over JCS of { schemaHash, inputHash, outputHash }. */
  readonly decisionHash: HashString;
  readonly schemaRef?: string;
  readonly adapter?: AdapterInfo;
}
