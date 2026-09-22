/**
 * @rubric/attest-index — SQLite day-shard attestation index (tasks/P2.md).
 *
 * Writer + query lib over per-day WAL shards, plus a backfill that rebuilds the
 * index from a bundle store. The bundle store is the source of truth; the index
 * is a rebuildable cache.
 */
export {
  type IndexRow,
  type AttestationBundle,
  rowFromBundle,
  shardKeyForTs,
  shardFileName,
  dayKeyFromFileName,
  DDL,
} from "./schema.js";
export { Shard, type ShardOptions } from "./shard.js";
export { Index, type IndexOptions } from "./store.js";
export { backfill, type BackfillResult } from "./backfill.js";
