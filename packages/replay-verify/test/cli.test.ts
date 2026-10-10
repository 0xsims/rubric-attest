/** CLI: arguments, exit codes (§4.4) and the --json report shape. */
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { PINNED, fakeNet, keysFile, noSleep, tieredFixture, type Json } from "./helpers.js";

function io(files: Record<string, string>, net = fakeNet({ messages: tieredFixture().messages, keys: keysFile({ anchorPayers: [PINNED] }) })) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    net,
    io: {
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      readFile: (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return files[p]!;
      },
      fetch: net.fetch,
      sleep: noSleep,
    },
  };
}

function goodFiles(): Record<string, string> {
  const f = tieredFixture();
  return { "rec.json": JSON.stringify(f.record), "anchor.json": JSON.stringify(f.bundle), "keys.json": JSON.stringify(keysFile({ anchorPayers: [PINNED] })) };
}

describe("rubric-replay CLI", () => {
  it("exit 2 without --record/--anchor-bundle", async () => {
    const t = io({});
    expect(await main(["--record", "rec.json"], t.io)).toBe(2);
    expect(t.err.join("")).toContain("usage:");
  });

  it("exit 2 on an unknown flag or a positional", async () => {
    expect(await main(["--record", "a", "--anchor-bundle", "b", "--bogus"], io({}).io)).toBe(2);
    expect(await main(["x"], io({}).io)).toBe(2);
  });

  it("exit 2 on an unreadable file", async () => {
    const t = io({ "anchor.json": "{}" });
    expect(await main(["--record", "missing.json", "--anchor-bundle", "anchor.json"], t.io)).toBe(2);
  });

  it("exit 2 on non-JSON input", async () => {
    const files = { ...goodFiles(), "rec.json": "not json" };
    expect(await main(["--record", "rec.json", "--anchor-bundle", "anchor.json"], io(files).io)).toBe(2);
  });

  it("exit 2 on a record that is neither a tiered record nor a completed DAR bundle", async () => {
    const files = { ...goodFiles(), "rec.json": JSON.stringify({ hello: 1 }) };
    expect(await main(["--record", "rec.json", "--anchor-bundle", "anchor.json"], io(files).io)).toBe(2);
  });

  it("exit 2 on a warm file array without exactly one tiered record", async () => {
    const f = tieredFixture();
    const files = { ...goodFiles(), "rec.json": JSON.stringify([f.record, f.record]) };
    expect(await main(["--record", "rec.json", "--anchor-bundle", "anchor.json"], io(files).io)).toBe(2);
  });

  it("accepts a warm file array with exactly one tiered record", async () => {
    const f = tieredFixture();
    const files = { ...goodFiles(), "rec.json": JSON.stringify([{ other: true }, f.record]) };
    expect(await main(["--record", "rec.json", "--anchor-bundle", "anchor.json"], io(files).io)).toBe(0);
  });

  it("exit 2 on a --keys file with no signers", async () => {
    const files = { ...goodFiles(), "keys.json": "{}" };
    expect(await main(["--record", "rec.json", "--anchor-bundle", "anchor.json", "--keys", "keys.json"], io(files).io)).toBe(2);
  });

  it("exit 2 for --mirror mainnet.mirrornode.hedera.com or a rubric-protocol.com host", async () => {
    for (const m of ["https://mainnet.mirrornode.hedera.com", "https://rubric-protocol.com"]) {
      const t = io(goodFiles());
      expect(await main(["--record", "rec.json", "--anchor-bundle", "anchor.json", "--mirror", m], t.io)).toBe(2);
      expect(t.net.requests).toEqual([]);
    }
  });

  it("exit 2 for a malformed --topic", async () => {
    expect(await main(["--record", "rec.json", "--anchor-bundle", "anchor.json", "--topic", "0.0.010416909"], io(goodFiles()).io)).toBe(2);
  });

  it("exit 0 and the --json report shape", async () => {
    const t = io(goodFiles());
    const code = await main(["--record", "rec.json", "--anchor-bundle", "anchor.json", "--keys", "keys.json", "--json"], t.io);
    expect(code).toBe(0);
    const r: Json = JSON.parse(t.out.join(""));
    expect(Object.keys(r).sort()).toEqual(["anchor", "anchorPayers", "exitCode", "recordKind", "steps", "verdict", "verdictDetail", "warnings"]);
    expect(r.verdict).toBe("PASS");
    expect(r.steps.map((s: Json) => s.name)).toEqual(["signature", "leaf", "batch", "aggregate", "anchor"]);
    for (const s of r.steps) expect(Object.keys(s).sort()).toEqual(["detail", "name", "reason", "status"]);
    for (const k of ["anchorId", "aggregateRoot", "sequenceNumber", "consensusTimestamp", "payerAccountId", "topic", "mirror"]) expect(r.anchor).toHaveProperty(k);
    expect(r.anchor.topic).toBe("0.0.10416909");
    expect(r.anchorPayers).toEqual({ source: "keys-file", accounts: [PINNED], attested: false, warnings: [] });
    expect(t.net.requests.some((u) => u.includes("rubric-protocol.com"))).toBe(false);
  });

  it("text output lists all five steps, the topic and the payer source", async () => {
    const t = io(goodFiles());
    expect(await main(["--record", "rec.json", "--anchor-bundle", "anchor.json"], t.io)).toBe(0);
    const text = t.out.join("");
    for (const n of ["signature", "leaf", "batch", "aggregate", "anchor"]) expect(text).toContain(n);
    expect(text).toContain("topic 0.0.10416909");
    expect(text).toContain("anchor payers (built-in)");
  });

  it("a --topic other than 0.0.10416909 is called out in every output mode", async () => {
    // The record must not name a topic itself, else this is TOPIC_MISMATCH (exit 1).
    const rec = tieredFixture().record;
    delete rec.anchors.hcs.topic_id;
    for (const json of [true, false]) {
      const t = io({ ...goodFiles(), "rec.json": JSON.stringify(rec) }, fakeNet({ messages: [], keys: keysFile({ anchorPayers: [PINNED] }) }));
      const args = ["--record", "rec.json", "--anchor-bundle", "anchor.json", "--topic", "0.0.5"];
      const code = await main(json ? [...args, "--json"] : args, t.io);
      expect(code).toBe(3);
      const out = t.out.join("");
      expect(out).toContain("topic 0.0.5 is not the Rubric anchor topic 0.0.10416909");
      if (json) expect(JSON.parse(out).anchor.topic).toBe("0.0.5");
    }
  });

  it("a --mirror other than the default is called out in every output mode", async () => {
    for (const json of [true, false]) {
      const t = io(goodFiles());
      const args = ["--record", "rec.json", "--anchor-bundle", "anchor.json", "--mirror", "https://mirror.example.org"];
      const code = await main(json ? [...args, "--json"] : args, t.io);
      expect(code).toBe(0);
      const out = t.out.join("");
      expect(out).toContain("NOTE: mirror https://mirror.example.org is not the default public mirror https://mainnet-public.mirrornode.hedera.com");
      if (json) expect(JSON.parse(out).verdictDetail).toContain("NOTE: mirror https://mirror.example.org");
    }
  });

  it("exit 1 on FAIL, 3 on UNSUPPORTED, 4 on UNAVAILABLE", async () => {
    const f = tieredFixture();
    const bad = JSON.parse(JSON.stringify(f.record));
    bad.merkle_proof_directions.pop();
    expect(await main(["--record", "rec.json", "--anchor-bundle", "anchor.json"], io({ ...goodFiles(), "rec.json": JSON.stringify(bad) }).io)).toBe(1);
    expect(await main(["--record", "rec.json", "--anchor-bundle", "anchor.json"], io(goodFiles(), fakeNet({ messages: [], keys: keysFile() })).io)).toBe(3);
    expect(await main(["--record", "rec.json", "--anchor-bundle", "anchor.json"], io(goodFiles(), fakeNet({ messages: [], keys: keysFile(), mirrorStatus: 503 })).io)).toBe(4);
  });
});
