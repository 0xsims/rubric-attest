/**
 * A single day-shard: one WAL-mode SQLite file with the four indexed queries
 * from tasks/P2.md. `insert` is idempotent (keyed on attestationId), which is
 * what makes backfill idempotent and the index rebuildable from bundles alone.
 *
 * Schema v2 (tasks/P6-index.md) adds nullable anchor columns with ADD COLUMN
 * when a writer opens the shard. A read-only v1 shard stays queryable.
 */
import Database from "better-sqlite3";
import {
  DDL,
  NO_ANCHORS,
  SCHEMA_VERSION,
  V1_COLUMNS,
  V2_COLUMNS,
  type AnchorColumns,
  type AnchoredRow,
  type IndexRow,
} from "./schema.js";

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

const V1_SELECT = `SELECT ${V1_COLUMNS.join(", ")} FROM attestations`;
const ANCHOR_SELECT = V2_COLUMNS.map(([c]) => c).join(", ");

interface RawAnchors {
  anchorId: string | null;
  aggregateRoot: string | null;
  hcsSequences: string | null;
  hcsConsensusTs: string | null;
  anchorConflict: number | null;
}

function parseAnchors(r: RawAnchors): AnchorColumns {
  return {
    anchorId: r.anchorId,
    aggregateRoot: r.aggregateRoot,
    hcsSequences: r.hcsSequences === null ? null : (JSON.parse(r.hcsSequences) as string[]),
    hcsConsensusTs: r.hcsConsensusTs,
    anchorConflict: r.anchorConflict === null ? null : r.anchorConflict ? 1 : 0,
  };
}

/** Bring a writable shard to SCHEMA_VERSION. Refuses a newer shard. */
function migrate(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    throw new Error(`index: shard schema v${version} is newer than this writer (v${SCHEMA_VERSION}); refusing to write`);
  }
  db.transaction(() => {
    db.exec(DDL);
    const have = new Set((db.prepare("PRAGMA table_info(attestations)").all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of V2_COLUMNS) {
      if (!have.has(name)) db.exec(`ALTER TABLE attestations ADD COLUMN ${name} ${type}`);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

export class Shard {
  readonly db: Database.Database;
  /** True when the anchor columns exist (any shard a v2 writer has opened). */
  readonly hasAnchorColumns: boolean;
  private readonly insertStmt: Database.Statement<[IndexRow]>;
  private readonly byDecisionStmt: Database.Statement;
  private readonly byDecisionAnchoredStmt: Database.Statement | null;
  private readonly byAgentRangeStmt: Database.Statement;
  private readonly byAgentSchemaStmt: Database.Statement;
  private readonly chainHeadStmt: Database.Statement;
  private readonly insertMany: Database.Transaction<(rows: IndexRow[]) => number>;

  constructor(path: string, options: ShardOptions = {}) {
    const readonly = options.readonly ?? false;
    this.db = new Database(path, { readonly });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    if (!readonly) migrate(this.db);
    const cols = new Set((this.db.prepare("PRAGMA table_info(attestations)").all() as { name: string }[]).map((c) => c.name));
    this.hasAnchorColumns = V2_COLUMNS.every(([c]) => cols.has(c));

    this.insertStmt = this.db.prepare(INSERT_SQL);
    // ORDER BY ts, then decisionId as a stable tiebreak within a millisecond.
    this.byDecisionStmt = this.db.prepare(`${V1_SELECT} WHERE decisionId = ?`);
    this.byDecisionAnchoredStmt = this.hasAnchorColumns
      ? this.db.prepare(`SELECT ${V1_COLUMNS.join(", ")}, ${ANCHOR_SELECT} FROM attestations WHERE decisionId = ?`)
      : null;
    this.byAgentRangeStmt = this.db.prepare(
      `${V1_SELECT} WHERE agentId = ? AND ts >= ? AND ts <= ? ORDER BY ts, decisionId LIMIT ?`,
    );
    this.byAgentSchemaStmt = this.db.prepare(
      `${V1_SELECT} WHERE agentId = ? AND schemaHash = ? ORDER BY ts, decisionId LIMIT ?`,
    );
    this.chainHeadStmt = this.db.prepare(
      `${V1_SELECT} WHERE agentId = ? ORDER BY decisionId DESC LIMIT 1`,
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

  /** byDecisionId plus the anchor columns; all null on a shard without them. */
  byDecisionIdAnchored(decisionId: string): AnchoredRow | undefined {
    if (!this.byDecisionAnchoredStmt) {
      const row = this.byDecisionId(decisionId);
      return row && { ...row, ...NO_ANCHORS };
    }
    const r = this.byDecisionAnchoredStmt.get(decisionId) as (IndexRow & RawAnchors) | undefined;
    if (!r) return undefined;
    const row = Object.fromEntries(V1_COLUMNS.map((c) => [c, r[c]])) as unknown as IndexRow;
    return { ...row, ...parseAnchors(r) };
  }

  /** Every row's attestationId and anchor columns (for ingest). Requires the anchor columns. */
  anchorsByAttestation(): Map<string, AnchorColumns> {
    const out = new Map<string, AnchorColumns>();
    for (const r of this.db.prepare(`SELECT attestationId, ${ANCHOR_SELECT} FROM attestations`).all() as
      (RawAnchors & { attestationId: string })[]) {
      out.set(r.attestationId, parseAnchors(r));
    }
    return out;
  }

  /** Overwrite a row's anchor columns in one transaction. Returns rows changed. */
  setAnchors(updates: ReadonlyArray<readonly [attestationId: string, anchors: AnchorColumns]>): number {
    const stmt = this.db.prepare(
      `UPDATE attestations SET anchorId = ?, aggregateRoot = ?, hcsSequences = ?, hcsConsensusTs = ?, anchorConflict = ?
       WHERE attestationId = ?`,
    );
    return this.db.transaction(() => {
      let n = 0;
      for (const [id, a] of updates) {
        n += stmt.run(a.anchorId, a.aggregateRoot, a.hcsSequences === null ? null : JSON.stringify(a.hcsSequences),
          a.hcsConsensusTs, a.anchorConflict, id).changes;
      }
      return n;
    })();
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
