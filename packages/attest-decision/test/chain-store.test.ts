import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Attestor,
  ChainHeadStoreError,
  DarBuilder,
  FileChainHeadStore,
  Spool,
  type DarCore,
  type Transport,
} from "../src/index.js";

const childPath = fileURLToPath(new URL("./helpers/chain-child.mts", import.meta.url));

class SinkTransport implements Transport {
  sent: DarCore[] = [];
  async send(records: DarCore[]): Promise<void> {
    this.sent.push(...records);
  }
}
const offline: Transport = { send: () => Promise.reject(new Error("offline")) };

let dir: string;
let storeDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rubric-chain-"));
  storeDir = join(dir, "dar-chain");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const input = (n: number, agentId = "A") => ({ agentId, schema: { type: "object" }, input: { n }, output: { ok: true } });

/** Deterministic ids and clock so two runs can be compared byte for byte. */
function deterministic() {
  let i = 0;
  return {
    newDecisionId: () => `01J${String(i++).padStart(23, "0")}`,
    now: () => Date.UTC(2026, 8, 23),
  };
}

/** Linearity over a set of DARs for one agent, as decision-verify's chainCheck judges it. */
function shape(dars: DarCore[]) {
  const ids = new Set(dars.map((d) => d.decisionId));
  const children = new Map<string, number>();
  for (const d of dars) if (d.prev !== null) children.set(d.prev, (children.get(d.prev) ?? 0) + 1);
  return {
    count: dars.length,
    genesis: dars.filter((d) => d.prev === null).length,
    heads: dars.filter((d) => !children.has(d.decisionId)).length,
    branches: [...children.values()].filter((n) => n > 1).length,
    gaps: dars.filter((d) => d.prev !== null && !ids.has(d.prev)).length,
  };
}

describe("default (no chainStore) is unchanged", () => {
  it("produces exactly what DarBuilder alone produces, and touches no store", async () => {
    const t = new SinkTransport();
    const a = new Attestor({ transport: t, spoolPath: join(dir, "s.spool"), ...deterministic() });
    const b = new DarBuilder(deterministic());
    const expected: DarCore[] = [];
    for (let n = 0; n < 5; n++) {
      a.attest(input(n, n % 2 ? "A" : "B"));
      expected.push(b.build(input(n, n % 2 ? "A" : "B")));
    }
    await a.close();
    expect(JSON.stringify(t.sent)).toBe(JSON.stringify(expected));
    expect(existsSync(storeDir)).toBe(false);
  });

  it("a single process with a store yields the same records as without one", async () => {
    const plain = new SinkTransport();
    const a = new Attestor({ transport: plain, spoolPath: join(dir, "a.spool"), ...deterministic() });
    const stored = new SinkTransport();
    const s = new Attestor({
      transport: stored,
      spoolPath: join(dir, "b.spool"),
      chainStore: new FileChainHeadStore({ dir: storeDir }),
      ...deterministic(),
    });
    for (let n = 0; n < 6; n++) {
      a.attest(input(n, n % 3 ? "A" : "B"));
      s.attest(input(n, n % 3 ? "A" : "B"));
    }
    await a.close();
    await s.close();
    expect(JSON.stringify(stored.sent)).toBe(JSON.stringify(plain.sent));
  });
});

describe("FileChainHeadStore", () => {
  it("resumes the chain after a restart with an empty spool", async () => {
    const t1 = new SinkTransport();
    const a1 = new Attestor({ transport: t1, spoolPath: join(dir, "w0.spool"), chainStore: new FileChainHeadStore({ dir: storeDir }) });
    const ids1 = [a1.attest(input(1)), a1.attest(input(2)), a1.attest(input(3))];
    await a1.close();
    expect(t1.sent.map((d) => d.prev)).toEqual([null, ids1[0], ids1[1]]);

    // New process: fresh builder, fresh spool path, same store dir.
    const store = new FileChainHeadStore({ dir: storeDir });
    expect(store.readHead("A")).toBe(ids1[2]);
    const t2 = new SinkTransport();
    const a2 = new Attestor({ transport: t2, spoolPath: join(dir, "w1.spool"), chainStore: store });
    const id4 = a2.attest(input(4));
    await a2.close();
    expect(t2.sent[0]!.prev).toBe(ids1[2]);
    expect(store.readHead("A")).toBe(id4);
    expect(shape([...t1.sent, ...t2.sent])).toEqual({ count: 4, genesis: 1, heads: 1, branches: 0, gaps: 0 });
  });

  it("interleaved Attestors (two workers) in one process share one chain per agent", async () => {
    const t = new SinkTransport();
    const mk = (name: string) =>
      new Attestor({ transport: t, spoolPath: join(dir, name), chainStore: new FileChainHeadStore({ dir: storeDir }) });
    const w0 = mk("w0.spool");
    const w1 = mk("w1.spool");
    for (let n = 0; n < 20; n++) (n % 2 ? w0 : w1).attest(input(n, n % 4 < 2 ? "A" : "B"));
    await w0.close();
    await w1.close();
    for (const agent of ["A", "B"]) {
      expect(shape(t.sent.filter((d) => d.agentId === agent))).toEqual({ count: 10, genesis: 1, heads: 1, branches: 0, gaps: 0 });
    }
  });

  it("keeps one linear chain under concurrent attests from several processes", async () => {
    const P = 4;
    const N = 60;
    const goFile = join(dir, "go");
    const runs = Array.from({ length: P }, (_, w) =>
      new Promise<{ ids: (string | null)[]; errors: string[] }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", childPath, storeDir, join(dir, `w${w}.spool`), String(N), "rubric://x402/decision-review", goFile],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        child.on("error", reject);
        child.on("exit", (code) => {
          const line = out.split("\n").find((l) => l.startsWith("RESULT:"));
          if (code !== 0 || !line) reject(new Error(`child ${w} exited ${code}\n${err}`));
          else resolve(JSON.parse(line.slice(7)));
        });
      }),
    );
    // Let every child load and block on the go-file, then release them together.
    await new Promise((r) => setTimeout(r, 1500));
    writeFileSync(goFile, "");
    const results = await Promise.all(runs);

    for (const r of results) {
      expect(r.errors).toEqual([]);
      expect(r.ids.every((id) => typeof id === "string")).toBe(true);
    }
    const dars: DarCore[] = [];
    for (let w = 0; w < P; w++) {
      const spool = new Spool(join(dir, `w${w}.spool`));
      dars.push(...spool.pending().map((p) => p.dar));
      spool.close();
    }
    expect(shape(dars)).toEqual({ count: P * N, genesis: 1, heads: 1, branches: 0, gaps: 0 });

    // The stored head is the chain's single head.
    const head = new FileChainHeadStore({ dir: storeDir }).readHead("rubric://x402/decision-review");
    expect(dars.some((d) => d.prev === head)).toBe(false);
    expect(dars.some((d) => d.decisionId === head)).toBe(true);
    // No lock or temp files left behind.
    expect(readdirSync(storeDir).filter((f) => !f.endsWith(".head"))).toEqual([]);
  }, 60_000);

  it("skips the record (null, no spool, no head change) when the lock can't be had in time", async () => {
    const store = new FileChainHeadStore({ dir: storeDir, lockTimeoutMs: 30 });
    const errors: unknown[] = [];
    const spoolPath = join(dir, "w0.spool");
    const a = new Attestor({ transport: offline, spoolPath, chainStore: store, onError: (e) => errors.push(e), closeRetries: 0, retryMs: 1 });
    const first = a.attest(input(1));
    // A live holder: this very process, fresh.
    const lock = store.headPath("A").replace(/\.head$/, ".lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: "x", token: "t", at: Date.now() }));

    expect(a.attest(input(2))).toBeNull();
    const timeout = errors.find((e) => e instanceof ChainHeadStoreError);
    expect((timeout as ChainHeadStoreError).code).toBe("lock-timeout");
    expect(a.pendingCount()).toBe(1);
    expect(store.readHead("A")).toBe(first);

    rmSync(lock);
    const third = a.attest(input(3));
    expect(store.readHead("A")).toBe(third);
    await a.close();
    const spool = new Spool(spoolPath);
    expect(spool.pending().map((p) => p.dar.prev)).toEqual([null, first]);
    spool.close();
  });

  it("breaks a lock left by a dead process", async () => {
    const store = new FileChainHeadStore({ dir: storeDir, lockTimeoutMs: 30 });
    const t = new SinkTransport();
    const a = new Attestor({ transport: t, spoolPath: join(dir, "w0.spool"), chainStore: store });
    const lock = store.headPath("A").replace(/\.head$/, ".lock");
    // pid 2^22+1 is above Linux's pid_max ceiling, so it can't be alive.
    writeFileSync(lock, JSON.stringify({ pid: 4194305, host: (await import("node:os")).hostname(), token: "t", at: Date.now() }));
    expect(a.attest(input(1))).not.toBeNull();
    expect(existsSync(lock)).toBe(false);
    await a.close();
  });

  it("breaks a lock older than staleLockMs even if its holder looks alive", async () => {
    const store = new FileChainHeadStore({ dir: storeDir, lockTimeoutMs: 200, staleLockMs: 50 });
    const a = new Attestor({ transport: new SinkTransport(), spoolPath: join(dir, "w0.spool"), chainStore: store });
    const lock = store.headPath("A").replace(/\.head$/, ".lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: "elsewhere", token: "t", at: 0 }));
    await new Promise((r) => setTimeout(r, 80));
    expect(a.attest(input(1))).not.toBeNull();
    await a.close();
  });

  it("repairs the head on recovery after a crash between spool append and head write", async () => {
    const spoolPath = join(dir, "w0.spool");
    const store = new FileChainHeadStore({ dir: storeDir });
    const a1 = new Attestor({ transport: offline, spoolPath, chainStore: store, closeRetries: 0, retryMs: 1 });
    const r1 = a1.attest(input(1))!;
    const r2 = a1.attest(input(2))!;
    await a1.close(); // undelivered: both stay spooled
    // Simulate the crash window: r2 was spooled but its head write never happened.
    writeFileSync(store.headPath("A"), JSON.stringify({ v: 1, agentId: "A", head: r1 }));

    const t = new SinkTransport();
    const a2 = new Attestor({ transport: t, spoolPath, chainStore: store });
    expect(store.readHead("A")).toBe(r2);
    a2.attest(input(3));
    await a2.close();
    expect(t.sent.map((d) => d.prev)).toEqual([null, r1, r2]);
  });

  it("does not move a head that another process has already extended", async () => {
    const spoolPath = join(dir, "w0.spool");
    const store = new FileChainHeadStore({ dir: storeDir });
    const a1 = new Attestor({ transport: offline, spoolPath, chainStore: store, closeRetries: 0, retryMs: 1 });
    a1.attest(input(1));
    await a1.close();
    writeFileSync(store.headPath("A"), JSON.stringify({ v: 1, agentId: "A", head: "OTHER-WORKER-HEAD" }));
    const a2 = new Attestor({ transport: new SinkTransport(), spoolPath, chainStore: store });
    expect(store.readHead("A")).toBe("OTHER-WORKER-HEAD");
    await a2.close();
  });

  it("an empty store is seeded from this process's recovered head, not a new genesis", async () => {
    const spoolPath = join(dir, "w0.spool");
    const a1 = new Attestor({ transport: offline, spoolPath, closeRetries: 0, retryMs: 1 }); // no store yet
    const r1 = a1.attest(input(1))!;
    await a1.close();
    const store = new FileChainHeadStore({ dir: storeDir });
    const t = new SinkTransport();
    const a2 = new Attestor({ transport: t, spoolPath, chainStore: store });
    const r2 = a2.attest(input(2));
    await a2.close();
    expect(t.sent.map((d) => d.prev)).toEqual([null, r1]);
    expect(store.readHead("A")).toBe(r2);
  });

  it("fails closed on a corrupt head file: record skipped, never a new genesis", async () => {
    const store = new FileChainHeadStore({ dir: storeDir });
    const errors: unknown[] = [];
    const a = new Attestor({ transport: new SinkTransport(), spoolPath: join(dir, "w0.spool"), chainStore: store, onError: (e) => errors.push(e) });
    writeFileSync(store.headPath("A"), "{not json");
    expect(a.attest(input(1))).toBeNull();
    expect((errors[0] as ChainHeadStoreError).code).toBe("io");
    expect(a.pendingCount()).toBe(0);
    expect(readFileSync(store.headPath("A"), "utf8")).toBe("{not json");
    await a.close();
  });

  it("never throws into the caller, even for a bad agentId", async () => {
    const a = new Attestor({ transport: new SinkTransport(), spoolPath: join(dir, "w0.spool"), chainStore: new FileChainHeadStore({ dir: storeDir }) });
    expect(a.attest({ ...input(1), agentId: "" })).toBeNull();
    expect(a.attest({ ...input(1), agentId: 7 as unknown as string })).toBeNull();
    await a.close();
  });

  it("keeps per-agent files keyed by SHA3-256 of the agentId", () => {
    const store = new FileChainHeadStore({ dir: storeDir });
    store.advance("rubric://x402/decision-review", () => "X");
    const [file] = readdirSync(storeDir);
    expect(file).toMatch(/^[0-9a-f]{64}\.head$/);
    expect(JSON.parse(readFileSync(join(storeDir, file!), "utf8"))).toEqual({ v: 1, agentId: "rubric://x402/decision-review", head: "X" });
  });
});
