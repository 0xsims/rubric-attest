import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Index, Shard, SCHEMA_VERSION, type IndexRow } from "../src/index.js";

// The v1 DDL as published in 1.0.x-1.2.x, verbatim, so the migration is tested against real v1 shards.
const V1_DDL = `
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
const V1_KEYS = ["attestationId", "decisionId", "agentId", "schemaHash", "decisionHash", "prev", "ts", "leafType", "bundlePath"];

const row = (n: number): IndexRow => ({
  attestationId: `att-${n}`, decisionId: `D${n}`, agentId: "agent://A", schemaHash: "sha3-256:s",
  decisionHash: `sha3-256:${n}`, prev: n > 1 ? `D${n - 1}` : null, ts: `2025-09-22T00:00:0${n}.000Z`,
  leafType: "decision", bundlePath: `decisions/2025-09-22/D${n}.json`,
});

let dir: string;
let path: string;
function makeV1(rows: IndexRow[]): void {
  const db = new Database(path);
  db.pragma("journal_mode = WAL"); // as the v1 Shard created them
  db.exec(V1_DDL);
  const ins = db.prepare(`INSERT INTO attestations VALUES (@attestationId, @decisionId, @agentId, @schemaHash, @decisionHash, @prev, @ts, @leafType, @bundlePath)`);
  for (const r of rows) ins.run(r);
  db.close();
}
function schemaObjects(): { type: string; name: string }[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare("SELECT type, name FROM sqlite_master ORDER BY type, name").all() as { type: string; name: string }[];
  } finally { db.close(); }
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rubric-v2-"));
  path = join(dir, "attest-2025-09-22.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("schema v2 migration", () => {
  it("v1 -> v2 is ADD COLUMN only: every row survives, no new table or index", () => {
    makeV1([row(1), row(2), row(3)]);
    const before = schemaObjects();
    const s = new Shard(path);
    try {
      expect(s.db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(s.count()).toBe(3);
      const ids = (s.db.prepare("SELECT attestationId FROM attestations ORDER BY attestationId").all() as { attestationId: string }[]).map((r) => r.attestationId);
      expect(ids).toEqual(["att-1", "att-2", "att-3"]);
      const cols = (s.db.prepare("PRAGMA table_info(attestations)").all() as { name: string; notnull: number }[]);
      expect(cols.map((c) => c.name)).toEqual([...V1_KEYS, "anchorId", "aggregateRoot", "hcsSequences", "hcsConsensusTs", "anchorConflict"]);
      expect(cols.slice(V1_KEYS.length).every((c) => c.notnull === 0)).toBe(true);
      expect(s.byDecisionIdAnchored("D2")).toMatchObject({ ...row(2), anchorId: null, hcsSequences: null, anchorConflict: null });
    } finally { s.close(); }
    expect(schemaObjects()).toEqual(before);
  });

  it("migrating twice is a no-op", () => {
    makeV1([row(1)]);
    new Shard(path).close();
    const s = new Shard(path);
    try { expect(s.count()).toBe(1); } finally { s.close(); }
  });

  it("a read-only v1 shard is still queryable, and is not migrated", () => {
    makeV1([row(1), row(2)]);
    const s = new Shard(path, { readonly: true });
    try {
      expect(s.hasAnchorColumns).toBe(false);
      expect(s.byDecisionId("D2")).toEqual(row(2));
      expect(s.byDecisionIdAnchored("D2")).toEqual({ ...row(2), anchorId: null, aggregateRoot: null, hcsSequences: null,
        hcsConsensusTs: null, anchorConflict: null });
      expect(s.byAgentRange("agent://A", "2025-09-22T00:00:00.000Z", "2025-09-22T23:59:59.999Z").length).toBe(2);
    } finally { s.close(); }
    const idx = new Index(dir, { readonly: true });
    try { expect(idx.byDecisionIdAnchored("D1")?.anchorId).toBeNull(); } finally { idx.close(); }
    const db = new Database(path, { readonly: true });
    try { expect(db.pragma("user_version", { simple: true })).toBe(0); } finally { db.close(); }
  });

  it("a writer refuses a shard whose user_version is above 2", () => {
    makeV1([row(1)]);
    const db = new Database(path);
    db.pragma("user_version = 3");
    db.close();
    expect(() => new Shard(path)).toThrow(/newer than this writer/);
    expect(() => new Index(dir).write(row(9))).toThrow(/newer than this writer/);
    const ro = new Shard(path, { readonly: true });
    try { expect(ro.byDecisionId("D1")).toEqual(row(1)); } finally { ro.close(); }
  });

  it("IndexRow results keep their v1 shape on a v2 shard (no anchor keys)", () => {
    const s = new Shard(path);
    try {
      s.insertBatch([row(1), row(2)]);
      s.setAnchors([["att-1", { anchorId: "a", aggregateRoot: "r", hcsSequences: ["5"], hcsConsensusTs: null, anchorConflict: 0 }]]);
      expect(Object.keys(s.byDecisionId("D1")!)).toEqual(V1_KEYS);
      expect(Object.keys(s.chainHead("agent://A")!)).toEqual(V1_KEYS);
      for (const r of s.byAgentRange("agent://A", "2025-09-22T00:00:00.000Z", "2025-09-22T23:59:59.999Z")) expect(Object.keys(r)).toEqual(V1_KEYS);
      for (const r of s.byAgentSchema("agent://A", "sha3-256:s")) expect(Object.keys(r)).toEqual(V1_KEYS);
      expect(s.byDecisionIdAnchored("D1")).toEqual({ ...row(1), anchorId: "a", aggregateRoot: "r", hcsSequences: ["5"],
        hcsConsensusTs: null, anchorConflict: 0 });
    } finally { s.close(); }
  });

  it("an upsert (backfill) never touches the anchor columns", () => {
    const s = new Shard(path);
    try {
      s.insert(row(1));
      s.setAnchors([["att-1", { anchorId: "a", aggregateRoot: "r", hcsSequences: ["5", "7"], hcsConsensusTs: "1.000000001", anchorConflict: 0 }]]);
      s.insert({ ...row(1), bundlePath: "moved.json" });
      expect(s.byDecisionIdAnchored("D1")).toMatchObject({ bundlePath: "moved.json", hcsSequences: ["5", "7"] });
    } finally { s.close(); }
  });
});
