/**
 * A single day-shard: one WAL-mode SQLite file with the four indexed queries
 * from tasks/P2.md. `insert` is idempotent (keyed on attestationId), which is
 * what makes backfill idempotent and the index rebuildable from bundles alone.
 */
import Database from "better-sqlite3";
import { DDL, type IndexRow } from "./schema.js";

export interface ShardOptions {
  readonly?: boolean;
}

const INSERT_SQL = `
INSERT INTO attestations
  (attestationId, decisionId, agentId, schemaHash, decisionHash, prev, ts, leafType, bundlePath)
VALUES
  (@attestationId, @decisionId, @agentId, @schemaHash, @decisionHash, @prev, @ts, @leafType, @bundlePath)
ON CONFLICT(attestationId) DO UPDATE SET
  decisionId   = excluded.decisionId,
  agentId      = excluded.agentId,
  schemaHash   = excluded.schemaHash,
  decisionHash = excluded.decisionHash,
  prev         = excluded.prev,
  ts           = excluded.ts,
  leafType     = excluded.leafType,
  bundlePath   = excluded.bundlePath
`;

export class Shard {
  readonly db: Database.Database;
  private readonly insertStmt: Database.Statement<[IndexRow]>;
  private readonly byDecisionStmt: Database.Statement;
  private readonly byAgentRangeStmt: Database.Statement;
  private readonly byAgentSchemaStmt: Database.Statement;
  private readonly chainHeadStmt: Database.Statement;
  private readonly insertMany: Database.Transaction<(rows: IndexRow[]) => number>;

  constructor(path: string, options: ShardOptions = {}) {
    this.db = new Database(path, { readonly: options.readonly ?? false });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    if (!options.readonly) this.db.exec(DDL);

    this.insertStmt = this.db.prepare(INSERT_SQL);
    // ORDER BY ts, then decisionId as a stable tiebreak within a millisecond.
    this.byDecisionStmt = this.db.prepare(
      "SELECT * FROM attestations WHERE decisionId = ?",
    );
    this.byAgentRangeStmt = this.db.prepare(
      "SELECT * FROM attestations WHERE agentId = ? AND ts >= ? AND ts <= ? ORDER BY ts, decisionId LIMIT ?",
    );
    this.byAgentSchemaStmt = this.db.prepare(
      "SELECT * FROM attestations WHERE agentId = ? AND schemaHash = ? ORDER BY ts, decisionId LIMIT ?",
    );
    this.chainHeadStmt = this.db.prepare(
      "SELECT * FROM attestations WHERE agentId = ? ORDER BY decisionId DESC LIMIT 1",
    );
    this.insertMany = this.db.transaction((rows: IndexRow[]) => {
      for (const r of rows) this.insertStmt.run(r);
      return rows.length;
    });
  }

  /** Idempotent single-row upsert. */
  insert(row: IndexRow): void {
    this.insertStmt.run(row);
  }

  /** Idempotent bulk upsert in one transaction. Throws on any row error. */
  insertBatch(rows: IndexRow[]): number {
    return this.insertMany(rows);
  }

  /**
   * Idempotent bulk upsert with per-row error isolation, in one transaction.
   * A row that violates a constraint (e.g. a conflicting duplicate decisionId)
   * is skipped and counted in `failed` — the good rows still commit. This is
   * what keeps backfill robust: one bad bundle cannot roll back a whole shard.
   */
  insertResilient(rows: IndexRow[]): { written: number; failed: number } {
    let written = 0;
    let failed = 0;
    const run = this.db.transaction((rs: IndexRow[]) => {
      for (const r of rs) {
        try {
          this.insertStmt.run(r);
          written++;
        } catch {
          failed++;
        }
      }
    });
    run(rows);
    return { written, failed };
  }

  byDecisionId(decisionId: string): IndexRow | undefined {
    return this.byDecisionStmt.get(decisionId) as IndexRow | undefined;
  }

  byAgentRange(agentId: string, fromTs: string, toTs: string, limit = -1): IndexRow[] {
    return this.byAgentRangeStmt.all(agentId, fromTs, toTs, limit) as IndexRow[];
  }

  byAgentSchema(agentId: string, schemaHash: string, limit = -1): IndexRow[] {
    return this.byAgentSchemaStmt.all(agentId, schemaHash, limit) as IndexRow[];
  }

  /** The chain tip for an agent: the latest decisionId (ULID is chronological). */
  chainHead(agentId: string): IndexRow | undefined {
    return this.chainHeadStmt.get(agentId) as IndexRow | undefined;
  }

  count(): number {
    return (this.db.prepare("SELECT count(*) AS c FROM attestations").get() as { c: number }).c;
  }

  close(): void {
    this.db.close();
  }
}
