import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Shard } from "../src/index.js";

const ROWS = 1_000_000;
const AGENTS = 1000; // 1000 decisions per agent
const BASE_MS = Date.UTC(2025, 8, 22, 0, 0, 0); // 2025-09-22, single shard day
const pad = (n: number) => String(n).padStart(12, "0");
const agentId = (a: number) => `agent://a${String(a).padStart(4, "0")}`;

let dir: string;
let path: string;
let shard: Shard;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rubric-idxperf-"));
  path = join(dir, "attest-2025-09-22.sqlite");

  // Bulk-load the table first (no secondary indexes), then let Shard build them
  // — much faster than maintaining five indexes during a 1M-row load.
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = OFF");
  db.exec(`CREATE TABLE attestations (
    attestationId TEXT PRIMARY KEY, decisionId TEXT NOT NULL, agentId TEXT NOT NULL,
    schemaHash TEXT NOT NULL, decisionHash TEXT NOT NULL, prev TEXT, ts TEXT NOT NULL,
    leafType TEXT NOT NULL, bundlePath TEXT NOT NULL)`);
  const ins = db.prepare(
    "INSERT INTO attestations VALUES (?,?,?,?,?,?,?,?,?)",
  );
  const CHUNK = 50_000;
  const insChunk = db.transaction((from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const agent = i % AGENTS;
      const seq = Math.floor(i / AGENTS); // 0..999
      const ts = new Date(BASE_MS + seq * 1000).toISOString();
      ins.run(
        "att" + pad(i),
        pad(i),
        agentId(agent),
        "sha3-256:s" + (seq % 4),
        "sha3-256:h",
        null,
        ts,
        "decision",
        "b",
      );
    }
  });
  for (let from = 0; from < ROWS; from += CHUNK) insChunk(from, Math.min(from + CHUNK, ROWS));
  db.close();

  shard = new Shard(path); // builds the 5 indexes over 1M rows
}, 180_000);

afterAll(() => {
  shard?.close();
  rmSync(dir, { recursive: true, force: true });
});

function medianMs(fn: () => void, iters = 50): number {
  fn(); // warm
  const s = new Array<number>(iters);
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    s[i] = Number(process.hrtime.bigint() - t0) / 1e6;
  }
  s.sort((a, b) => a - b);
  return s[Math.floor(iters / 2)]!;
}

describe("index queries on a 1M-row shard", () => {
  it("has the full fixture loaded", () => {
    expect(shard.count()).toBe(ROWS);
  });

  it("byDecisionId < 10 ms", () => {
    const target = pad(250_500); // agent 500, seq 250
    expect(shard.byDecisionId(target)?.decisionId).toBe(target);
    const m = medianMs(() => shard.byDecisionId(target));
    console.log(`byDecisionId median=${m.toFixed(4)}ms`);
    expect(m).toBeLessThan(10);
  });

  it("byAgentRange < 10 ms", () => {
    const from = new Date(BASE_MS + 100_000).toISOString();
    const to = new Date(BASE_MS + 200_000).toISOString();
    const rows = shard.byAgentRange(agentId(500), from, to);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.agentId === agentId(500))).toBe(true);
    const m = medianMs(() => shard.byAgentRange(agentId(500), from, to));
    console.log(`byAgentRange median=${m.toFixed(4)}ms (${rows.length} rows)`);
    expect(m).toBeLessThan(10);
  });

  it("byAgentSchema < 10 ms", () => {
    const rows = shard.byAgentSchema(agentId(500), "sha3-256:s0");
    expect(rows.length).toBeGreaterThan(0);
    const m = medianMs(() => shard.byAgentSchema(agentId(500), "sha3-256:s0"));
    console.log(`byAgentSchema median=${m.toFixed(4)}ms (${rows.length} rows)`);
    expect(m).toBeLessThan(10);
  });

  it("chainHead < 10 ms", () => {
    const head = shard.chainHead(agentId(500));
    expect(head?.agentId).toBe(agentId(500));
    const m = medianMs(() => shard.chainHead(agentId(500)));
    console.log(`chainHead median=${m.toFixed(4)}ms`);
    expect(m).toBeLessThan(10);
  });
});
