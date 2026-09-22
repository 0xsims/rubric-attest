/**
 * Index — a directory of day-shards (tasks/P2.md). Routes writes to the shard
 * for a row's `ts` day, and fans the four queries out across shards, merging.
 * Shard handles are opened lazily and cached.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Shard } from "./shard.js";
import {
  dayKeyFromFileName,
  shardFileName,
  shardKeyForTs,
  type IndexRow,
} from "./schema.js";

export interface IndexOptions {
  readonly?: boolean;
}

export class Index {
  private readonly dir: string;
  private readonly readOnly: boolean;
  private readonly shards = new Map<string, Shard>();
  private dayCache: string[] | null = null;

  constructor(dir: string, options: IndexOptions = {}) {
    this.dir = dir;
    this.readOnly = options.readonly ?? false;
    if (!this.readOnly) mkdirSync(dir, { recursive: true });
  }

  /** Day keys with an existing shard file, ascending. Cached per instance. */
  shardDays(): string[] {
    if (this.dayCache) return this.dayCache;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      this.dayCache = [];
      return this.dayCache;
    }
    this.dayCache = names
      .map(dayKeyFromFileName)
      .filter((k): k is string => k !== null)
      .sort();
    return this.dayCache;
  }

  private shardForDay(day: string, createIfMissing: boolean): Shard | undefined {
    const cached = this.shards.get(day);
    if (cached) return cached;
    const exists = this.shardDays().includes(day);
    // Readonly / query paths must not create a shard file that isn't there.
    if (!exists && (this.readOnly || !createIfMissing)) return undefined;
    const shard = new Shard(join(this.dir, shardFileName(day)), { readonly: this.readOnly });
    this.shards.set(day, shard);
    if (!exists && this.dayCache) {
      this.dayCache.push(day);
      this.dayCache.sort();
    }
    return shard;
  }

  /** Idempotent write, routed to the row's day shard. */
  write(row: IndexRow): void {
    const day = shardKeyForTs(row.ts);
    const shard = this.shardForDay(day, true)!;
    shard.insert(row);
  }

  /** Idempotent bulk write. Rows may span days; each is routed to its shard. */
  writeBatch(rows: IndexRow[]): number {
    let n = 0;
    for (const [day, dayRows] of this.groupByDay(rows)) {
      n += this.shardForDay(day, true)!.insertBatch(dayRows);
    }
    return n;
  }

  /**
   * Idempotent bulk write with per-row error isolation (for backfill). A row
   * that fails to insert (e.g. a conflicting duplicate decisionId) is counted
   * in `failed` rather than aborting its shard. Rows must already have a valid
   * day key (callers validate `ts` up front).
   */
  writeBatchResilient(rows: IndexRow[]): { written: number; failed: number } {
    let written = 0;
    let failed = 0;
    for (const [day, dayRows] of this.groupByDay(rows)) {
      const r = this.shardForDay(day, true)!.insertResilient(dayRows);
      written += r.written;
      failed += r.failed;
    }
    return { written, failed };
  }

  private groupByDay(rows: IndexRow[]): Map<string, IndexRow[]> {
    const byDay = new Map<string, IndexRow[]>();
    for (const r of rows) {
      const day = shardKeyForTs(r.ts);
      (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(r);
    }
    return byDay;
  }

  private openShards(): Shard[] {
    return this.shardDays()
      .map((day) => this.shardForDay(day, false))
      .filter((s): s is Shard => s !== undefined);
  }

  byDecisionId(decisionId: string): IndexRow | undefined {
    for (const shard of this.openShards()) {
      const row = shard.byDecisionId(decisionId);
      if (row) return row;
    }
    return undefined;
  }

  byAgentRange(agentId: string, fromTs: string, toTs: string, limit = -1): IndexRow[] {
    const fromDay = shardKeyForTs(fromTs);
    const toDay = shardKeyForTs(toTs);
    const rows: IndexRow[] = [];
    for (const day of this.shardDays()) {
      if (day < fromDay || day > toDay) continue;
      const shard = this.shardForDay(day, false);
      if (shard) rows.push(...shard.byAgentRange(agentId, fromTs, toTs, limit));
    }
    rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.decisionId < b.decisionId ? -1 : 1));
    return limit >= 0 ? rows.slice(0, limit) : rows;
  }

  byAgentSchema(agentId: string, schemaHash: string, limit = -1): IndexRow[] {
    const rows: IndexRow[] = [];
    for (const shard of this.openShards()) {
      rows.push(...shard.byAgentSchema(agentId, schemaHash, limit));
    }
    rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.decisionId < b.decisionId ? -1 : 1));
    return limit >= 0 ? rows.slice(0, limit) : rows;
  }

  /** Global chain tip for an agent across all shards (max decisionId). */
  chainHead(agentId: string): IndexRow | undefined {
    let head: IndexRow | undefined;
    for (const shard of this.openShards()) {
      const h = shard.chainHead(agentId);
      if (h && (!head || h.decisionId > head.decisionId)) head = h;
    }
    return head;
  }

  count(): number {
    return this.openShards().reduce((n, s) => n + s.count(), 0);
  }

  close(): void {
    for (const shard of this.shards.values()) shard.close();
    this.shards.clear();
  }
}
