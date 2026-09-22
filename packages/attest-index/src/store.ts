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

  constructor(dir: string, options: IndexOptions = {}) {
    this.dir = dir;
    this.readOnly = options.readonly ?? false;
    if (!this.readOnly) mkdirSync(dir, { recursive: true });
  }

  /** Day keys with an existing shard file, ascending. */
  shardDays(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .map(dayKeyFromFileName)
      .filter((k): k is string => k !== null)
      .sort();
  }

  private shardForDay(day: string, createIfMissing: boolean): Shard | undefined {
    const cached = this.shards.get(day);
    if (cached) return cached;
    const path = join(this.dir, shardFileName(day));
    if (this.readOnly || !createIfMissing) {
      // Only open if the file already exists (readonly open throws otherwise).
      if (!this.shardDays().includes(day)) return undefined;
    }
    const shard = new Shard(path, { readonly: this.readOnly });
    this.shards.set(day, shard);
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
    const byDay = new Map<string, IndexRow[]>();
    for (const r of rows) {
      const day = shardKeyForTs(r.ts);
      (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(r);
    }
    let n = 0;
    for (const [day, dayRows] of byDay) {
      n += this.shardForDay(day, true)!.insertBatch(dayRows);
    }
    return n;
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
