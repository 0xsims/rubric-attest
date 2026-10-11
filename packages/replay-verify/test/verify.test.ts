/**
 * End-to-end verifier tests against synthesized fixtures (signed with TEST keys)
 * served through a fake mirror on the injected fetch. No network.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/jcs.js";
import { verify, type Report } from "../src/verify.js";
import { computeAggregateRoot, batchLeaf, buildBatchTree } from "../src/merkle.js";
import { reassemble, parseMirrorMessage, type MirrorMessage } from "../src/mirror.js";
import { KEYS_FALLBACK_URL, KEYS_URL } from "../src/constants.js";
import {
  FOREIGN,
  MIRROR,
  PINNED,
  TOPIC,
  anchorBody,
  chunked,
  clone,
  darFixture,
  fakeNet,
  keysFile,
  noSleep,
  noise,
  publicKey,
  sha256hex,
  sign,
  single,
  tieredFixture,
  tsFromMs,
  type Json,
  type MirrorMsg,
} from "./helpers.js";

interface RunOpts {
  record: Json;
  bundle: Json;
  messages: MirrorMsg[];
  fetchedKeys?: Json | null;
  pinnedKeys?: Json;
  pageSize?: number;
  mirrorStatus?: number;
  keysStatus?: number;
  nextOverride?: string;
  topic?: string;
  mirror?: string;
}

async function rv(o: RunOpts): Promise<{ report: Report; requests: string[] }> {
  const net = fakeNet({
    messages: o.messages,
    keys: o.fetchedKeys === undefined ? keysFile({ anchorPayers: [PINNED] }) : o.fetchedKeys,
    pageSize: o.pageSize,
    mirrorStatus: o.mirrorStatus,
    keysStatus: o.keysStatus,
    nextOverride: o.nextOverride,
  });
  const report = await verify({ record: o.record, anchorBundle: o.bundle, keys: o.pinnedKeys, fetch: net.fetch, sleep: noSleep, topic: o.topic, mirror: o.mirror });
  return { report, requests: net.requests };
}

const step = (r: Report, name: string) => r.steps.find((s) => s.name === name)!;

function expectNotRunNeverPass(r: Report) {
  expect(r.steps.map((s) => s.name)).toEqual(["signature", "leaf", "batch", "aggregate", "anchor"]);
  for (const s of r.steps) if (s.reason === "NOT_RUN") expect(s.status).not.toBe("PASS");
}

function expectResult(r: Report, exit: number, stepName?: string, status?: string, reason?: string) {
  expectNotRunNeverPass(r);
  expect(r.exitCode).toBe(exit);
  if (exit !== 0) expect(r.verdict).not.toBe("PASS");
  if (stepName) {
    const s = step(r, stepName);
    expect({ status: s.status, reason: s.reason }).toEqual({ status, reason });
  }
}

/** Re-sign the tiered record's envelope with `signer`, embedding `embedded`'s public key everywhere. */
function resignTiered(rec: Json, signer: string, embedded = signer) {
  const sig = sign(signer, rec.tier1.envelope);
  const pk = publicKey(embedded);
  rec.tier1.signature = sig;
  rec.signature = sig;
  rec.stub.signature = sig;
  rec.tier1.publicKey = pk;
  rec.publicKey = pk;
  rec.stub.publicKey = pk;
}

/** A body of ≥1024 bytes (two chunks). The optional fields are those publishTier2Anchor can emit; padding is test-only. */
function bigBody(b: Json): string {
  const extra = { zkAggregateRoot: "a".repeat(64), zkPayloadAggregateRoot: "b".repeat(64), prevFederationSigHash: "c".repeat(64), prevAnchorId: "11111111-2222-4333-8444-555555555555" };
  const base = anchorBody(b, extra);
  const body = base.length >= 1100 ? base : anchorBody(b, { ...extra, _testPadding: "x".repeat(1100 - base.length) });
  expect(Buffer.byteLength(body)).toBeGreaterThanOrEqual(1024);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(2048);
  return body;
}

// ===================================================================================
describe("positive cases", () => {
  it("tiered record: genuine single-part anchor with no chunk_info → PASS, exit 0", async () => {
    const f = tieredFixture();
    expect(f.messages[0]!.chunk_info).toBeUndefined();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 0);
    expect(report.verdict).toBe("PASS");
    expect(report.steps.every((s) => s.status === "PASS")).toBe(true);
    expect(report.anchor).toMatchObject({ anchorId: f.bundle.attestationId, aggregateRoot: f.bundle.aggregateRoot, sequenceNumber: 309001, payerAccountId: PINNED, topic: TOPIC, mirror: MIRROR });
    expect(report.anchorPayers).toEqual({ source: "built-in", accounts: [PINNED], warnings: [] });
  });

  it("single-part message carrying chunk_info total 1 → PASS", async () => {
    const f = tieredFixture();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: [single(f.body, 309001, tsFromMs(f.anchorTsMs), PINNED, true)] });
    expectResult(report, 0);
  });

  it("chunked message ≥1024 bytes with chunks out of sequence order reassembles and verifies", async () => {
    const f = tieredFixture();
    const body = bigBody(f.bundle);
    const [c1, c2] = chunked(body, [309002, 309001], f.anchorTsMs);
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: [c2!, c1!] });
    expectResult(report, 0);
    expect(report.anchor.sequenceNumber).toBe(309002); // chunk 1's sequence (P6 chunk-1 rule)
  });

  it("forged chunk from a non-pinned payer claiming the genuine initial_transaction_id is dropped → PASS", async () => {
    const f = tieredFixture();
    const body = bigBody(f.bundle);
    const genuine = chunked(body, [309001, 309002], f.anchorTsMs);
    const forged = chunked(anchorBody(f.bundle, { aggregateRoot: "f".repeat(64), _p: "y".repeat(1100) }), [309003, 309004], f.anchorTsMs, FOREIGN, PINNED);
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: [...genuine, forged[1]!] });
    expectResult(report, 0);
  });

  it("forged message with the same anchorId and another aggregateRoot from a non-pinned payer is ignored → PASS", async () => {
    const f = tieredFixture();
    const forged = single(anchorBody(f.bundle, { aggregateRoot: "e".repeat(64) }), 309002, tsFromMs(f.anchorTsMs + 10), FOREIGN);
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: [...f.messages, forged] });
    expectResult(report, 0);
    expect(report.anchor.genuineMessages).toBe(1);
  });

  it("retry: two genuine messages with the same anchorId and root → PASS, earliest consensus_timestamp reported", async () => {
    const f = tieredFixture();
    const retryTs = tsFromMs(f.anchorTsMs + 120_000);
    const msgs = [...f.messages, single(anchorBody(f.bundle, {}, "2026-10-10T01:02:31.000Z"), 309100, retryTs)];
    f.record.anchors.hcs.sequence_number = 309100; // hint points at the retry
    f.bundle.seqNum = "309100";
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: msgs });
    expectResult(report, 0);
    expect(report.anchor.genuineMessages).toBe(2);
    expect(report.anchor.sequenceNumber).toBe(309001);
    expect(report.anchor.consensusTimestamp).toBe(f.messages[0]!.consensus_timestamp);
  });

  it("no stored sequence number: found by the anchoredAt window search across ≥2 links.next pages", async () => {
    const f = tieredFixture();
    f.record.anchors.hcs.sequence_number = null;
    f.bundle.seqNum = null;
    const start = Date.parse(f.bundle.anchoredAt) - 10 * 60_000;
    const msgs = [...noise(308990, 10, start, 30_000), ...f.messages];
    const { report, requests } = await rv({ record: f.record, bundle: f.bundle, messages: msgs, pageSize: 3 });
    expectResult(report, 0);
    const nextPages = requests.filter((u) => u.includes("sequencenumber=gt:"));
    expect(nextPages.length).toBeGreaterThanOrEqual(2);
    expect(report.anchor.searched!.sequenceRanges).toEqual([]);
  });

  it("DAR bundle, tier1-batch signature source → PASS", async () => {
    const f = darFixture("tier1Batch");
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expect(report.recordKind).toBe("dar");
    expectResult(report, 0);
  });

  it("DAR bundle, tier2-federation signature source → PASS", async () => {
    const f = darFixture("tier2Federation");
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 0);
    expect(step(report, "signature").detail).toContain("3 valid signatures");
  });

  it("retired key used before its rotatedAt → PASS", async () => {
    const f = tieredFixture();
    const keys = keysFile({ anchorPayers: [PINNED], override: { us: "rogue" }, extra: [{ region: "us", oracleId: null, keyId: "legacy", algorithm: "ML-DSA-65", publicKey: publicKey("us"), createdAt: "2026-01-01T00:00:00.000Z", rotatedAt: "2026-10-11T00:00:00.000Z", status: "retired" }] });
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: keys });
    expectResult(report, 0);
  });
});

// ===================================================================================
describe("keys source and the anchor-payer list", () => {
  it("--keys: zero requests to TenPrint hosts; anchorPayers from the file, reported keys-file and unattested", async () => {
    const f = tieredFixture();
    const { report, requests } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, pinnedKeys: keysFile({ anchorPayers: [PINNED] }) });
    expectResult(report, 0);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((u) => /(^|\.)(tenprint\.ai|rubric-protocol\.com)$/.test(new URL(u).hostname))).toEqual([]);
    expect(requests.every((u) => u.startsWith(`${MIRROR}/api/v1/topics/${TOPIC}/messages?`))).toBe(true);
    expect(report.anchorPayers).toEqual({ source: "keys-file", accounts: [PINNED], attested: false, warnings: [] });
  });

  it("--keys without anchorPayers → built-in list", async () => {
    const f = tieredFixture();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, pinnedKeys: keysFile() });
    expectResult(report, 0);
    expect(report.anchorPayers.source).toBe("built-in");
    expect(report.anchorPayers.attested).toBeUndefined();
  });

  it("fetched file without anchorPayers → built-in list", async () => {
    const f = tieredFixture();
    const { report, requests } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: keysFile() });
    expectResult(report, 0);
    expect(report.anchorPayers.source).toBe("built-in");
    expect(requests[0]).toBe(KEYS_URL);
  });

  it("fetched anchorPayers omitting the built-in payer: built-in still used, PASS with a warning", async () => {
    const f = tieredFixture();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: keysFile({ anchorPayers: ["0.0.4000000"] }) });
    expectResult(report, 0);
    expect(report.anchorPayers.accounts).toEqual([PINNED]);
    expect(report.anchorPayers.source).toBe("built-in");
    expect(report.anchorPayers.warnings.join(" ")).toContain("omits built-in payer 0.0.3923341");
  });

  it("--keys anchorPayers [] → no genuine payer, exit 3, even though the built-in list would match", async () => {
    const f = tieredFixture();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, pinnedKeys: keysFile({ anchorPayers: [] }) });
    expectResult(report, 3, "anchor", "UNSUPPORTED", "ANCHOR_ORIGIN_UNVERIFIED");
  });

  it('--keys anchorPayers ["0.0.39"]: no prefix/substring match against 0.0.3923341, exit 3', async () => {
    const f = tieredFixture();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, pinnedKeys: keysFile({ anchorPayers: ["0.0.39"] }) });
    expectResult(report, 3, "anchor", "UNSUPPORTED", "ANCHOR_ORIGIN_UNVERIFIED");
  });

  const invalid: [string, unknown][] = [
    ["null", null],
    ['"0.0.3923341"', "0.0.3923341"],
    ["[3923341]", [3923341]],
    ['["0.0.3923341-abcde"]', ["0.0.3923341-abcde"]],
    ['["0.0.3923341\\n"]', ["0.0.3923341\n"]],
    ['["0.0.03923341"]', ["0.0.03923341"]],
  ];
  for (const [label, value] of invalid) {
    for (const mode of ["--keys", "fetched"] as const) {
      it(`anchorPayers ${label} (${mode}) → UNSUPPORTED ANCHOR_PAYERS_INVALID, exit 3, no fallback`, async () => {
        const f = tieredFixture();
        const k = keysFile({ anchorPayers: value });
        const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, ...(mode === "--keys" ? { pinnedKeys: k } : { fetchedKeys: k }) });
        expectResult(report, 3, "anchor", "UNSUPPORTED", "ANCHOR_PAYERS_INVALID");
      });
    }
  }

  it("fetched anchorPayers adds an unpinned payer whose message is the only match → UNSUPPORTED ANCHOR_PAYER_UNPINNED, exit 3", async () => {
    const f = tieredFixture();
    const msgs = [single(f.body, 309001, tsFromMs(f.anchorTsMs), "0.0.5000000")];
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: msgs, fetchedKeys: keysFile({ anchorPayers: [PINNED, "0.0.5000000"] }) });
    expectResult(report, 3, "anchor", "UNSUPPORTED", "ANCHOR_PAYER_UNPINNED");
  });

  it("an unpinned payer's matching message without a fetched-file listing → ANCHOR_ORIGIN_UNVERIFIED", async () => {
    const f = tieredFixture();
    const msgs = [single(f.body, 309001, tsFromMs(f.anchorTsMs), "0.0.5000000")];
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: msgs });
    expectResult(report, 3, "anchor", "UNSUPPORTED", "ANCHOR_ORIGIN_UNVERIFIED");
  });
});

// ===================================================================================
describe("negative vectors (none gives exit 0)", () => {
  it("one byte changed in leafMessage → FAIL, exit 1", async () => {
    const f = tieredFixture();
    const p = f.record.stub.leafMessage.payload;
    p.payload_hash_unsalted = (p.payload_hash_unsalted[0] === "0" ? "1" : "0") + p.payload_hash_unsalted.slice(1);
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "leaf", "FAIL", "LEAF_MISMATCH");
  });

  it("one proof sibling changed → FAIL, exit 1", async () => {
    const f = tieredFixture();
    const s = f.record.merkle_proof[0] as string;
    const changed = (s[0] === "0" ? "1" : "0") + s.slice(1);
    f.record.merkle_proof[0] = changed;
    f.record.stub.merkleProof[0] = changed;
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "batch", "FAIL", "BATCH_ROOT_MISMATCH");
  });

  it("a forestRoot changed in the anchor bundle → FAIL, exit 1", async () => {
    const f = tieredFixture();
    f.bundle.tier1Flushes[0].forestRoot = "d".repeat(64);
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "aggregate", "FAIL", "AGGREGATE_ROOT_MISMATCH");
  });

  it("a forestRoot changed with a recomputed bundle aggregateRoot → step 5 FAIL against the anchor message", async () => {
    const f = tieredFixture();
    f.bundle.tier1Flushes[0].forestRoot = "d".repeat(64);
    f.bundle.aggregateRoot = computeAggregateRoot(f.bundle.tier1Flushes);
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "anchor", "FAIL", "AGGREGATE_ROOT_MISMATCH");
  });

  it("anchor bundle paired with the wrong anchor message (different anchorId) → FAIL, exit 1", async () => {
    const f = tieredFixture();
    const other = "99999999-8888-4777-8666-555555555555";
    f.bundle.attestationId = other;
    f.record.anchors.hcs.anchor_id = other;
    f.record.anchors.hcs.sequence_number = null; // with the hint, ANCHOR_ID_MISMATCH fires first (tested below)
    f.bundle.seqNum = null;
    const otherMsg = single(anchorBody({ ...f.bundle, aggregateRoot: "a".repeat(64) }), 309002, tsFromMs(f.anchorTsMs + 5));
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: [...f.messages, otherMsg] });
    expectResult(report, 1, "anchor", "FAIL", "AGGREGATE_ROOT_MISMATCH");
  });

  it("hinted sequence holds a genuine anchor with a different anchorId → FAIL ANCHOR_ID_MISMATCH", async () => {
    const f = tieredFixture();
    const wrong = single(anchorBody({ ...f.bundle, attestationId: "99999999-8888-4777-8666-555555555555" }), 309001, tsFromMs(f.anchorTsMs));
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: [wrong] });
    expectResult(report, 1, "anchor", "FAIL", "ANCHOR_ID_MISMATCH");
  });

  it("record anchors.hcs.anchor_id names another anchor → FAIL", async () => {
    const f = tieredFixture();
    f.record.anchors.hcs.anchor_id = "99999999-8888-4777-8666-555555555555";
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "batch", "FAIL", "ANCHOR_ID_MISMATCH");
  });

  it("signature by a different valid ML-DSA-65 key → FAIL, exit 1", async () => {
    const f = tieredFixture();
    resignTiered(f.record, "rogue", "us");
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "signature", "FAIL", "BAD_SIGNATURE");
  });

  it("keys file's key for the region differs from the embedded publicKey (rotated) → UNSUPPORTED KEY_NOT_PUBLISHED, exit 3", async () => {
    const f = tieredFixture();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: keysFile({ anchorPayers: [PINNED], override: { us: "rogue" } }) });
    expectResult(report, 3, "signature", "UNSUPPORTED", "KEY_NOT_PUBLISHED");
  });

  it("self-signed forgery: valid signature under an embedded key not in the keys file → exit 3, never 0", async () => {
    const f = tieredFixture();
    resignTiered(f.record, "rogue");
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 3, "signature", "UNSUPPORTED", "KEY_NOT_PUBLISHED");
  });

  it("the embedded key published only for another region → KEY_NOT_PUBLISHED", async () => {
    const f = tieredFixture();
    resignTiered(f.record, "sg");
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 3, "signature", "UNSUPPORTED", "KEY_NOT_PUBLISHED");
  });

  it("retired key used after its rotatedAt → UNSUPPORTED KEY_RETIRED, exit 3", async () => {
    const f = tieredFixture();
    const keys = keysFile({ anchorPayers: [PINNED], override: { us: "rogue" }, extra: [{ region: "us", oracleId: null, keyId: "legacy-shared-2026h1", algorithm: "ML-DSA-65", publicKey: publicKey("us"), createdAt: "2026-01-01T00:00:00.000Z", rotatedAt: "2026-06-15T00:00:00.000Z", status: "retired" }] });
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: keys });
    expectResult(report, 3, "signature", "UNSUPPORTED", "KEY_RETIRED");
  });

  it("retired key, no genuine anchor found → KEY_RETIRED (anchor time unknown), never PASS", async () => {
    const f = tieredFixture();
    const keys = keysFile({ anchorPayers: [PINNED], override: { us: "rogue" }, extra: [{ region: "us", keyId: "legacy", algorithm: "ML-DSA-65", publicKey: publicKey("us"), rotatedAt: "2030-01-01T00:00:00.000Z", status: "retired" }] });
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: [], fetchedKeys: keys });
    expectResult(report, 3, "signature", "UNSUPPORTED", "KEY_RETIRED");
  });

  it("treeVersion 2 in the anchor bundle → UNSUPPORTED, exit 3", async () => {
    const f = tieredFixture();
    f.bundle.treeVersion = 2;
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 3, "aggregate", "UNSUPPORTED", "TREE_VERSION_UNSUPPORTED");
    expect(step(report, "anchor")).toMatchObject({ status: "UNSUPPORTED", reason: "NOT_RUN" });
  });

  const algCases: [string, Json, string][] = [
    ["treeVersion 2 in the message", { treeVersion: 2 }, "ALG_UNSUPPORTED"],
    ["a level that differs from §2.4", { alg: { canonicalization: "JCS/RFC8785", zk: "Poseidon2-BN254", levels: { batch: { hash: "SHA-256", domainSeparation: "RFC6962", merkleOdd: "promote" }, aggregate: { hash: "SHA3-256", domainSeparation: "RFC6962", merkleOdd: "duplicate" }, wrap: { hash: "SHA3-256", domainSeparation: "none", merkleOdd: "self-pair" } } } }, "ALG_UNSUPPORTED"],
    ["descriptive-keys levels variant", { alg: { canonicalization: "JCS/RFC8785", zk: "Poseidon2-BN254", levels: { batch: { hash: "SHA-256", domainSeparation: "RFC6962", merkleOdd: "promote", leaf: "x" }, aggregate: { hash: "SHA3-256", domainSeparation: "RFC6962", merkleOdd: "promote" }, wrap: { hash: "SHA3-256", domainSeparation: "none", merkleOdd: "self-pair" } } } }, "ALG_UNSUPPORTED"],
    ["flat pre-August-2026 block", { alg: { leaf: "SHA-256", node: "SHA-256", aggregate: "SHA3-256", zk: "Poseidon2-BN254", canonicalization: "JCS/RFC8785", domainSeparation: "RFC6962", merkleOdd: "duplicate" } }, "ALG_LEGACY_FLAT"],
    ["flat block with no levels and no merkleOdd", { alg: { canonicalization: "JCS/RFC8785", zk: "Poseidon2-BN254" } }, "ALG_LEGACY_FLAT"],
    ["schemaVersion rubric-anchor/1", { schemaVersion: "rubric-anchor/1" }, "ALG_UNSUPPORTED"],
    ["no alg block", { alg: undefined }, "ALG_UNSUPPORTED"],
  ];
  for (const [label, override, reason] of algCases) {
    it(`${label} → UNSUPPORTED ${reason}, exit 3`, async () => {
      const f = tieredFixture();
      const { report } = await rv({ record: f.record, bundle: f.bundle, messages: [single(anchorBody(f.bundle, override), 309001, tsFromMs(f.anchorTsMs))] });
      expectResult(report, 3, "anchor", "UNSUPPORTED", reason);
    });
  }

  it("mirror returns 5xx past retries → UNAVAILABLE, exit 4", async () => {
    const f = tieredFixture();
    const { report, requests } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, mirrorStatus: 503 });
    expectResult(report, 4, "anchor", "UNAVAILABLE", "MIRROR_UNAVAILABLE");
    expect(requests.filter((u) => u.startsWith(MIRROR))).toHaveLength(6); // 1 + 5 retries, then stop
  });

  it("mirror returns 429 past retries → UNAVAILABLE, exit 4", async () => {
    const f = tieredFixture();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, mirrorStatus: 429 });
    expectResult(report, 4, "anchor", "UNAVAILABLE", "MIRROR_UNAVAILABLE");
  });

  it("both keys URLs unreachable → UNAVAILABLE, exit 4", async () => {
    const f = tieredFixture();
    const { report, requests } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: null });
    expectResult(report, 4, "signature", "UNAVAILABLE", "KEYS_UNAVAILABLE");
    expect(requests.filter((u) => u === KEYS_URL)).toHaveLength(6);
    expect(requests.filter((u) => u === KEYS_FALLBACK_URL)).toHaveLength(6);
    expect(step(report, "signature").detail).toContain(KEYS_URL);
    expect(step(report, "signature").detail).toContain(KEYS_FALLBACK_URL);
    expect(step(report, "anchor").status).toBe("PASS");
  });

  it("tenprint.ai serves the keys file → rubric-protocol.com is never contacted, no fallback warning", async () => {
    const f = tieredFixture();
    const { report, requests } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 0);
    expect(requests.filter((u) => new URL(u).hostname.endsWith("rubric-protocol.com"))).toEqual([]);
    expect(report.warnings.join(" ")).not.toContain("fallback");
  });

  for (const [label, primary] of [["unreachable", null], ["HTTP 404", 404], ["HTTP 503", 503], ["no signers array", { version: "1" }]] as const) {
    it(`tenprint.ai ${label} → falls back to rubric-protocol.com, PASS with a warning`, async () => {
      const f = tieredFixture();
      const net = fakeNet({ messages: f.messages, keys: keysFile({ anchorPayers: [PINNED] }), keysPerUrl: { [KEYS_URL]: primary } });
      const report = await verify({ record: f.record, anchorBundle: f.bundle, fetch: net.fetch, sleep: noSleep });
      expectResult(report, 0);
      expect(net.requests[0]).toBe(KEYS_URL);
      expect(net.requests.filter((u) => u === KEYS_FALLBACK_URL)).toHaveLength(1);
      expect(report.warnings.join(" ")).toContain(`keys file fetched from fallback ${KEYS_FALLBACK_URL}`);
    });
  }

  it("fallback rubric-protocol.com also unusable → UNAVAILABLE, exit 4", async () => {
    const f = tieredFixture();
    const net = fakeNet({ messages: f.messages, keysPerUrl: { [KEYS_URL]: 404, [KEYS_FALLBACK_URL]: { version: "1" } } });
    const report = await verify({ record: f.record, anchorBundle: f.bundle, fetch: net.fetch, sleep: noSleep });
    expectResult(report, 4, "signature", "UNAVAILABLE", "KEYS_UNAVAILABLE");
  });

  it("keys URL 5xx → UNAVAILABLE, exit 4", async () => {
    const f = tieredFixture();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, keysStatus: 502 });
    expectResult(report, 4, "signature", "UNAVAILABLE", "KEYS_UNAVAILABLE");
  });

  it("DAR core edited after signing → FAIL, exit 1", async () => {
    const f = darFixture("tier1Batch");
    f.record.dar.ts = "2026-10-10T02:00:00.001Z";
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "leaf", "FAIL", "LEAF_MISMATCH");
  });

  it("DAR core edited, federation source → FAIL, exit 1", async () => {
    const f = darFixture("tier2Federation");
    f.record.dar.prev = "01JA0000000000000000000001";
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "leaf", "FAIL", "LEAF_MISMATCH");
  });

  it("valid signed envelope from batch A with a leaf and proof from batch B (and a consistent forged anchor bundle) → FAIL: fold ≠ envelope.batch_root", async () => {
    const f = tieredFixture();
    const env = f.record.tier1.envelope;
    // Batch B: a leaf that agrees with A's envelope on id, time and region, but is another leaf.
    const lmB = { ...f.record.stub.leafMessage, payload: { payload_hash_unsalted: sha256hex("batch B") } };
    const filler = { ...lmB, attestation_id: "batch-b-other" };
    const lB = batchLeaf(lmB);
    const tB = buildBatchTree([lB.hash, batchLeaf(filler).hash]);
    const r = f.record;
    r.stub.leafMessage = lmB;
    r.payload = lmB.payload;
    r.stub.leafHash = lB.hash.toString("hex");
    r.stub.treeRoot = r.stub.leafHash;
    r.stub.payloadHash = sha256hex(lB.canonical);
    r.payload_hash = r.stub.payloadHash;
    r.merkle_proof = tB.proofs[0]!.siblings;
    r.merkle_proof_directions = tB.proofs[0]!.directions;
    r.stub.merkleProof = r.merkle_proof;
    r.stub.merkleProofDirections = r.merkle_proof_directions;
    // Forged anchor bundle consistent with batch B, and an anchor message for it.
    const flush = f.bundle.tier1Flushes.find((x: Json) => x.flushId === env.flush_id);
    flush.forestRoot = tB.root;
    flush.itemCount = 2;
    f.bundle.totalItems = f.bundle.tier1Flushes.reduce((s: number, x: Json) => s + x.itemCount, 0);
    f.bundle.aggregateRoot = computeAggregateRoot(f.bundle.tier1Flushes);
    const msgs = [single(anchorBody(f.bundle), 309001, tsFromMs(f.anchorTsMs))];
    const { report } = await rv({ record: r, bundle: f.bundle, messages: msgs });
    expectResult(report, 1, "batch", "FAIL", "BATCH_ROOT_MISMATCH");
  });

  it("tier1Flushes entry whose flushId disagrees with the signed envelope → FAIL, exit 1", async () => {
    const f = tieredFixture();
    const flush = f.bundle.tier1Flushes.find((x: Json) => x.flushId === f.record.tier1.envelope.flush_id);
    flush.flushId = "00000000-0000-4000-8000-000000000000";
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "batch", "FAIL", "FLUSH_NOT_IN_ANCHOR_BUNDLE");
  });

  it("tier1Flushes entry whose itemCount disagrees with the signed envelope → FAIL, exit 1", async () => {
    const f = tieredFixture();
    const flush = f.bundle.tier1Flushes.find((x: Json) => x.flushId === f.record.tier1.envelope.flush_id);
    flush.itemCount += 1;
    f.bundle.totalItems += 1;
    f.bundle.aggregateRoot = computeAggregateRoot(f.bundle.tier1Flushes);
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: [single(anchorBody(f.bundle), 309001, tsFromMs(f.anchorTsMs))] });
    expectResult(report, 1, "batch", "FAIL", "FLUSH_MISMATCH");
  });

  it("merkle_proof and merkle_proof_directions of different lengths → FAIL, exit 1", async () => {
    const f = tieredFixture();
    f.record.merkle_proof_directions = f.record.merkle_proof_directions.slice(0, -1);
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "batch", "FAIL", "PROOF_LENGTH_MISMATCH");
  });

  it("a proof direction that is not exactly L/R → FAIL", async () => {
    const f = tieredFixture();
    f.record.merkle_proof_directions[0] = "l";
    f.record.stub.merkleProofDirections[0] = "l";
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "batch", "FAIL", "MALFORMED");
  });

  it("a duplicated field that disagrees (stub.signature) → FAIL", async () => {
    const f = tieredFixture();
    f.record.stub.signature = sign("rogue", f.record.tier1.envelope);
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "signature", "FAIL", "DUPLICATE_MISMATCH");
  });

  it("uppercase hex batch_root in the envelope → FAIL MALFORMED (strict hex)", async () => {
    const f = tieredFixture();
    f.record.tier1.envelope.batch_root = f.record.tier1.envelope.batch_root.toUpperCase();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "signature", "FAIL", "MALFORMED");
  });

  it("an envelope with an extra key → FAIL ENVELOPE_INVALID", async () => {
    const f = tieredFixture();
    f.record.tier1.envelope.extra = 1;
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "signature", "FAIL", "ENVELOPE_INVALID");
  });

  it("forged anchor message with a matching anchorId from a non-pinned payer, no genuine message → UNSUPPORTED ANCHOR_ORIGIN_UNVERIFIED, exit 3", async () => {
    const f = tieredFixture();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: [single(f.body, 309001, tsFromMs(f.anchorTsMs), FOREIGN)] });
    expectResult(report, 3, "anchor", "UNSUPPORTED", "ANCHOR_ORIGIN_UNVERIFIED");
  });

  it("chunks whose payer_account_id differs from the initial_transaction_id account are discarded before reassembly", async () => {
    const f = tieredFixture();
    const chunks = chunked(bigBody(f.bundle), [309001, 309002], f.anchorTsMs, PINNED, "0.0.777");
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: chunks });
    expectResult(report, 3, "anchor", "UNSUPPORTED", "ANCHOR_ORIGIN_UNVERIFIED");
    const parsed = chunks.map((c) => parseMirrorMessage(c)!) as MirrorMessage[];
    expect(reassemble(parsed, TOPIC, (p) => p === PINNED)).toEqual([]);
  });

  it("a genuine chunked message still missing a chunk after a forged chunk is dropped does not count → exit 3", async () => {
    const f = tieredFixture();
    const body = bigBody(f.bundle);
    const [c1, c2] = chunked(body, [309001, 309002], f.anchorTsMs);
    const forged2 = { ...c2!, payer_account_id: FOREIGN, sequence_number: 309003 };
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: [c1!, forged2] });
    expectResult(report, 3, "anchor", "UNSUPPORTED", "ANCHOR_ORIGIN_UNVERIFIED");
  });

  it("a genuine chunk group with a repeated chunk number is dropped", () => {
    const f = tieredFixture();
    const [c1, c2] = chunked(bigBody(f.bundle), [309001, 309002], f.anchorTsMs);
    const dup = { ...c2!, sequence_number: 309003 };
    const parsed = [c1!, c2!, dup].map((c) => parseMirrorMessage(c)!) as MirrorMessage[];
    expect(reassemble(parsed, TOPIC, (p) => p === PINNED)).toEqual([]);
  });

  it("two genuine messages with the same anchorId and conflicting aggregateRoot → FAIL DUPLICATE_ANCHOR_CONFLICT, exit 1", async () => {
    const f = tieredFixture();
    const conflict = single(anchorBody(f.bundle, { aggregateRoot: "e".repeat(64) }), 309005, tsFromMs(f.anchorTsMs + 60_000));
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: [...f.messages, conflict] });
    expectResult(report, 1, "anchor", "FAIL", "DUPLICATE_ANCHOR_CONFLICT");
  });

  it("anchor message tier1Count disagreeing with the bundle → FAIL", async () => {
    const f = tieredFixture();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: [single(anchorBody(f.bundle, { tier1Count: 9 }), 309001, tsFromMs(f.anchorTsMs))] });
    expectResult(report, 1, "anchor", "FAIL", "ANCHOR_COUNT_MISMATCH");
  });

  it("links.next pointing off the mirror is refused by the guard → UNAVAILABLE, and never fetched", async () => {
    const f = tieredFixture();
    const { report, requests } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, nextOverride: "https://evil.example/api/v1/topics/0.0.10416909/messages?x=1" });
    expectResult(report, 4, "anchor", "UNAVAILABLE", "NETWORK_GUARD");
    expect(requests.some((u) => u.includes("evil.example"))).toBe(false);
  });

  it("links.next pointing at the topic-info endpoint is refused", async () => {
    const f = tieredFixture();
    const { report, requests } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, nextOverride: `/api/v1/topics/${TOPIC}` });
    expectResult(report, 4, "anchor", "UNAVAILABLE", "NETWORK_GUARD");
    expect(requests.some((u) => u.endsWith(`/api/v1/topics/${TOPIC}`))).toBe(false);
  });

  it("malformed anchor bundle id: dependent steps are NOT_RUN, never PASS", async () => {
    const f = tieredFixture();
    f.bundle.attestationId = "not-a-uuid";
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "aggregate", "FAIL", "MALFORMED");
    expect(step(report, "batch")).toMatchObject({ status: "UNSUPPORTED", reason: "NOT_RUN" });
    expect(step(report, "anchor")).toMatchObject({ status: "UNSUPPORTED", reason: "NOT_RUN" });
  });

  it("UNSUPPORTED and UNAVAILABLE together → exit 3", async () => {
    const f = tieredFixture();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: keysFile({ anchorPayers: [PINNED], override: { us: "rogue" } }), mirrorStatus: 500 });
    expectResult(report, 3);
    expect(step(report, "anchor").status).toBe("UNAVAILABLE");
  });
});

// ===================================================================================
describe("DAR-specific", () => {
  it("salted payload_commitment → step 2 UNSUPPORTED PAYLOAD_COMMITMENT, never exit 0", async () => {
    const f = darFixture("tier1Batch");
    const hop0 = f.record.extensions.rubricDar.bridge.hop0;
    hop0.leafMessage.payload = { payload_commitment: "a".repeat(64) };
    hop0.tier1LeafHash = batchLeaf(hop0.leafMessage).hash.toString("hex");
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expect(step(report, "leaf")).toMatchObject({ status: "UNSUPPORTED", reason: "PAYLOAD_COMMITMENT" });
    expect(report.exitCode).not.toBe(0);
  });

  it("tier1-batch: no published key for the region verifies → UNSUPPORTED KEY_NOT_PUBLISHED, exit 3", async () => {
    const f = darFixture("tier1Batch");
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: keysFile({ anchorPayers: [PINNED], override: { sg: "rogue" } }) });
    expectResult(report, 3, "signature", "UNSUPPORTED", "KEY_NOT_PUBLISHED");
  });

  it("tier2-federation: only two published keys → UNSUPPORTED FEDERATION_QUORUM_UNVERIFIED, exit 3", async () => {
    const f = darFixture("tier2Federation");
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: keysFile({ anchorPayers: [PINNED], override: { jp: "rogue" } }) });
    expectResult(report, 3, "signature", "UNSUPPORTED", "FEDERATION_QUORUM_UNVERIFIED");
  });

  it("tier2-federation: one key listed for three regions counts once", async () => {
    const f = darFixture("tier2Federation");
    const raw = f.record.extensions.rubricDar ? f.record.signature.raw : null;
    // Re-sign all three entries with the us key, each claiming its own region; the keys file lists that key for all three.
    for (const s of raw.signatures) { s.publicKey = publicKey("us"); s.signature = sign("us", raw.signedFields); }
    f.record.signature.signature = JSON.stringify(raw);
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: keysFile({ anchorPayers: [PINNED], override: { sg: "us", jp: "us" } }) });
    expectResult(report, 3, "signature", "UNSUPPORTED", "FEDERATION_QUORUM_UNVERIFIED");
  });

  it("tier2-federation: signedFields.anchored_at is not the bundle's anchoredAt → FAIL", async () => {
    const f = darFixture("tier2Federation");
    f.bundle.anchoredAt = "2026-10-10T02:01:00.001Z";
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "signature", "FAIL", "SIGNED_FIELDS_MISMATCH");
  });

  it("tier2-federation: a published-key signature that does not verify → FAIL", async () => {
    const f = darFixture("tier2Federation");
    const raw = f.record.signature.raw;
    raw.signatures[1].signature = sign("sg", { other: 1 });
    f.record.signature.signature = JSON.stringify(raw);
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "signature", "FAIL", "BAD_SIGNATURE");
  });

  it("unknown signature source → UNSUPPORTED", async () => {
    const f = darFixture("tier1Batch");
    f.record.signature.source = "something-else";
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 3, "signature", "UNSUPPORTED", "SIGNATURE_SOURCE_UNSUPPORTED");
  });

  it("hop2.anchorId names another anchor → FAIL", async () => {
    const f = darFixture("tier1Batch");
    f.record.extensions.rubricDar.bridge.hop2.anchorId = "99999999-8888-4777-8666-555555555555";
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "batch", "FAIL", "ANCHOR_ID_MISMATCH");
  });

  it("hop1 path direction missing (server would default it) → FAIL MALFORMED", async () => {
    const f = darFixture("tier1Batch");
    delete f.record.extensions.rubricDar.bridge.hop1.path[0].siblingDirection;
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "batch", "FAIL", "MALFORMED");
  });

  it("tier1-batch: tier1Flushes itemCount changed (rebuilt envelope no longer verifies) → never exit 0", async () => {
    const f = darFixture("tier1Batch");
    const b = clone(f.bundle);
    const fl = b.tier1Flushes.find((x: Json) => x.forestRoot === f.record.extensions.rubricDar.bridge.hop1.batchRoot);
    fl.itemCount += 1;
    const { report } = await rv({ record: f.record, bundle: b, messages: f.messages });
    expect(report.exitCode).not.toBe(0);
    expect(step(report, "signature")).toMatchObject({ status: "UNSUPPORTED", reason: "KEY_NOT_PUBLISHED" });
  });

  it("golden DAR vectors carry a dar-0.1 §2.1 decisionHash", () => {
    for (const kind of ["tier1Batch", "tier2Federation"] as const) {
      const d = darFixture(kind).record.dar;
      const want = "sha3-256:" + createHash("sha3-256").update(canonicalize({ schemaHash: d.schemaHash, inputHash: d.inputHash, outputHash: d.outputHash })).digest("hex");
      expect(d.decisionHash).toBe(want);
    }
  });

  const coreCases: [string, (dar: Json) => void][] = [
    ["a raw field (input) in the core", (d) => { d.input = { price: 1 }; }],
    ["a wrong decisionHash", (d) => { d.decisionHash = "sha3-256:" + "0".repeat(64); }],
    ["a hash with another algorithm prefix", (d) => { d.inputHash = d.inputHash.replace("sha3-256:", "sha256:"); }],
    ["an unknown leafType", (d) => { d.leafType = "verdict"; }],
    ["a missing required field (prev)", (d) => { delete d.prev; }],
  ];
  for (const [label, edit] of coreCases) {
    it(`DAR core with ${label} → FAIL DAR_CORE_INVALID, exit 1`, async () => {
      const f = darFixture("tier1Batch");
      edit(f.record.dar);
      const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
      expectResult(report, 1, "leaf", "FAIL", "DAR_CORE_INVALID");
    });
  }

  for (const v of ["DAR/0.2", "DAR/1.0"]) {
    it(`DAR core v ${v} → UNSUPPORTED DAR_VERSION_UNSUPPORTED, exit 3 (no leaf claim)`, async () => {
      const f = darFixture("tier1Batch");
      f.record.dar.v = v;
      f.record.dar.newField = "x"; // a higher minor may add fields; still UNSUPPORTED, not FAIL
      const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
      expectResult(report, 3, "leaf", "UNSUPPORTED", "DAR_VERSION_UNSUPPORTED");
    });
  }

  it("DAR anchorRef.topicId names another topic → FAIL TOPIC_MISMATCH", async () => {
    const f = darFixture("tier1Batch");
    f.record.anchorRef.topicId = "0.0.5";
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "anchor", "FAIL", "TOPIC_MISMATCH");
  });

  const retiredJp = (rotatedAt: string) => keysFile({ anchorPayers: [PINNED], override: { jp: "rogue" }, extra: [{ region: "jp", keyId: "legacy-jp", algorithm: "ML-DSA-65", publicKey: publicKey("jp"), rotatedAt, status: "retired" }] });

  it("tier2-federation: a retired key with the mirror unavailable → UNAVAILABLE, exit 4", async () => {
    const f = darFixture("tier2Federation");
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: retiredJp("2030-01-01T00:00:00.000Z"), mirrorStatus: 503 });
    expectResult(report, 4, "signature", "UNAVAILABLE", "NOT_RUN");
  });

  it("tier2-federation: a retired key used before its rotatedAt counts → PASS", async () => {
    const f = darFixture("tier2Federation");
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: retiredJp("2030-01-01T00:00:00.000Z") });
    expectResult(report, 0);
  });

  it("tier2-federation: a retired key needed for quorum under a non-default mirror → UNSUPPORTED KEY_RETIRED_UNTRUSTED_MIRROR, exit 3", async () => {
    const f = darFixture("tier2Federation");
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: retiredJp("2030-01-01T00:00:00.000Z"), mirror: "https://mirror.example.org" });
    expectResult(report, 3, "signature", "UNSUPPORTED", "KEY_RETIRED_UNTRUSTED_MIRROR");
  });
});

// ===================================================================================
describe("review fixes", () => {
  it("a duplicated copy present while its source of truth is absent → FAIL DUPLICATE_MISMATCH (not JCS_UNREPRESENTABLE)", async () => {
    const f = tieredFixture();
    const lm = f.record.stub.leafMessage;
    delete lm.payload;
    const { hash, canonical } = batchLeaf(lm);
    f.record.stub.leafHash = hash.toString("hex");
    f.record.stub.treeRoot = hash.toString("hex");
    f.record.stub.payloadHash = sha256hex(canonical);
    f.record.payload_hash = sha256hex(canonical);
    expect(f.record.payload).toBeDefined();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "leaf", "FAIL", "DUPLICATE_MISMATCH");
  });

  it("tiered anchors.hcs.topic_id names another topic → FAIL TOPIC_MISMATCH", async () => {
    const f = tieredFixture();
    f.record.anchors.hcs.topic_id = "0.0.5";
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 1, "anchor", "FAIL", "TOPIC_MISMATCH");
  });

  it("--topic other than the record's topic → FAIL TOPIC_MISMATCH", async () => {
    const f = tieredFixture();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, topic: "0.0.5" });
    expectResult(report, 1, "anchor", "FAIL", "TOPIC_MISMATCH");
  });

  it("an empty anchors.hcs.topic_id is not compared", async () => {
    const f = tieredFixture();
    f.record.anchors.hcs.topic_id = "";
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 0);
  });

  it("non-default mirror: PASS still possible, with a NOTE in the verdict detail", async () => {
    const f = tieredFixture();
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, mirror: "https://mirror.example.org" });
    expectResult(report, 0);
    expect(report.verdictDetail).toContain("NOTE: mirror https://mirror.example.org is not the default public mirror");
    expect(report.anchor.mirror).toBe("https://mirror.example.org");
  });

  it("non-default mirror: a retired key accepted only by that mirror's anchor time → UNSUPPORTED KEY_RETIRED_UNTRUSTED_MIRROR, exit 3", async () => {
    const f = tieredFixture();
    const keys = keysFile({ anchorPayers: [PINNED], override: { us: "rogue" }, extra: [{ region: "us", keyId: "legacy", algorithm: "ML-DSA-65", publicKey: publicKey("us"), rotatedAt: "2026-10-11T00:00:00.000Z", status: "retired" }] });
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages, fetchedKeys: keys, mirror: "https://mirror.example.org" });
    expectResult(report, 3, "signature", "UNSUPPORTED", "KEY_RETIRED_UNTRUSTED_MIRROR");
    expect(report.verdictDetail).toContain("NOTE: mirror");
  });

  it("tier1-batch: signature.raw is not compared (it may be an object, dar-emit.ts:990)", async () => {
    const f = darFixture("tier1Batch");
    f.record.signature.raw = { signature: f.record.signature.signature, publicKeyRef: "x" };
    const { report } = await rv({ record: f.record, bundle: f.bundle, messages: f.messages });
    expectResult(report, 0);
  });
});
