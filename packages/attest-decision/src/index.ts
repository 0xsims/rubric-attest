/**
 * @rubric/attest-decision — core SDK.
 *
 * P0 scaffolding: exports the frozen DAR/0.1 constants and types from
 * spec/dar-0.1.md so downstream packages have a stable home. The canonicalizer,
 * hasher, DAR builder, batcher, and spool land in P1 (see tasks/P1.md).
 */

/** Record format tag for the frozen DAR/0.1 field set. */
export const DAR_VERSION = "DAR/0.1" as const;

/** Hash algorithm invariant (spec/dar-0.1.md §4.1). SHA3-256 everywhere. */
export const HASH_ALGORITHM = "sha3-256" as const;

/** Prefix on hash-valued fields (spec/dar-0.1.md §4.2). */
export const HASH_PREFIX = `${HASH_ALGORITHM}:` as const;

/** Leaf discriminant values (spec/dar-0.1.md §2, `leafType`). */
export type LeafType = "decision" | "schema-change" | "checkpoint";

/** A `sha3-256:<hex>` encoded hash string. */
export type HashString = `${typeof HASH_ALGORITHM}:${string}`;

/**
 * The DAR core: the frozen, hashable field set (spec/dar-0.1.md §2).
 * The Merkle leaf hash is computed over the JCS canonicalization of this object.
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
