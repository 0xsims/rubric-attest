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

/** Leaf discriminant values (spec §2, `leafType`). */
export type LeafType = "decision" | "schema-change" | "checkpoint";

/** A `sha3-256:<hex>` encoded hash string. */
export type HashString = `${typeof HASH_ALGORITHM}:${string}`;

/**
 * The DAR core: the frozen, hashable field set (spec §2). The Merkle leaf hash
 * is computed over the JCS canonicalization of this object.
 */
export interface DarCore {
  readonly v: typeof DAR_VERSION;
  readonly decisionId: string;
  readonly agentId: string;
  readonly ts: string;
  readonly prev: string | null;
  readonly leafType: LeafType;
  readonly schemaHash: HashString;
  readonly decisionHash: HashString;
  readonly decision: Record<string, unknown>;
}
