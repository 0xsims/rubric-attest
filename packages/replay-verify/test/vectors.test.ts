/**
 * Golden vectors generated from rubric-protocol's own code (54afb5a1; see
 * vectors/README.md) must reproduce bit-for-bit with this package's code.
 */
import { describe, expect, it } from "vitest";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";
import { canonicalize } from "../src/jcs.js";
import { aggregateLeaf, aggregateTreeRoot, batchLeaf, buildBatchTree, computeAggregateRoot, foldBatch, wrap, type Direction } from "../src/merkle.js";
import { loadVector, secretKey, type Json } from "./helpers.js";
import { createHash } from "node:crypto";

const sha3 = (s: string) => createHash("sha3-256").update(s, "utf8").digest("hex");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("JCS vectors (canonical.ts)", () => {
  for (const c of loadVector("jcs.json").cases as Json[]) {
    it(`canonicalizes ${c.input.slice(0, 40)}`, () => {
      expect(canonicalize(JSON.parse(c.input))).toBe(c.canonical);
    });
  }
});

describe("batch trees of 1, 2, 3, 4, 5, 7 leaves (spec-merkle.ts)", () => {
  const trees = loadVector("batch-trees.json").trees as Json[];
  it("has exactly the six required sizes", () => {
    expect(trees.map((t) => t.n)).toEqual([1, 2, 3, 4, 5, 7]);
  });
  for (const t of trees) {
    it(`reproduces the ${t.n}-leaf tree: leaves, root and every proof`, () => {
      const hashes = t.leaves.map((l: Json) => {
        const { hash, canonical } = batchLeaf(l.leafMessage);
        expect(canonical).toBe(l.canonical);
        expect(hash.toString("hex")).toBe(l.leafHash);
        expect(sha256(canonical)).toBe(l.payloadHash);
        return hash;
      });
      const built = buildBatchTree(hashes);
      expect(built.root).toBe(t.root);
      t.proofs.forEach((p: Json, i: number) => {
        expect(built.proofs[i]!.siblings).toEqual(p.merkle_proof);
        expect(built.proofs[i]!.directions).toEqual(p.merkle_proof_directions);
        expect(foldBatch(hashes[i]!, p.merkle_proof, p.merkle_proof_directions as Direction[])).toBe(t.root);
      });
    });
  }
});

describe("aggregate trees of 1, 2, 3 flushes (makeLeafV2 → buildTreeV3 → buildForest)", () => {
  const cases = loadVector("aggregate-trees.json").cases as Json[];
  it("has exactly 1, 2 and 3 flushes", () => expect(cases.map((c) => c.flushCount)).toEqual([1, 2, 3]));
  for (const c of cases) {
    it(`reproduces ${c.flushCount} flush(es)`, () => {
      const leaves = c.flushes.map((f: Json, i: number) => {
        const l = aggregateLeaf(f.forestRoot, f.itemCount);
        expect(l).toBe(c.leaves[i].hash);
        expect("sha3-256:" + sha3(c.leaves[i].preimage)).toBe(l);
        return l;
      });
      expect(aggregateTreeRoot(leaves)).toBe(c.treeRoot);
      expect(wrap(c.treeRoot)).toBe(c.aggregateRoot);
      expect(computeAggregateRoot(c.flushes)).toBe(c.aggregateRoot);
      expect(c.treeVersion).toBe(3);
    });
  }
  it("flushId is not hashed: same root and count give the same leaf", () => {
    expect(cases[0].leaves[0].hash).toBe(cases[1].leaves[0].hash);
    expect(cases[0].flushes[0].flushId).not.toBe(cases[1].flushes[0].flushId);
  });
});

describe("wrap (buildForest with one tree)", () => {
  for (const c of loadVector("wrap.json").cases as Json[]) {
    it(`wraps ${c.root.slice(0, 12)}…`, () => expect(wrap(c.root)).toBe(c.wrapped));
  }
});

describe("ratified tiered vectors v0.1 (1, 3, 4 leaves) cross-check", () => {
  const r = loadVector("ratified-crosscheck.json");
  it("1 leaf", () => {
    const { hash, canonical } = batchLeaf(JSON.parse(r.oneLeaf.canonical));
    expect(canonical).toBe(r.oneLeaf.canonical);
    expect(hash.toString("hex")).toBe(r.oneLeaf.leafHash);
    expect(buildBatchTree([hash]).root).toBe(r.oneLeaf.root);
  });
  it("3 leaves", () => {
    const hashes = r.threeLeaves.canonicals.map((c: string) => batchLeaf(JSON.parse(c)).hash);
    expect(hashes.map((h: Buffer) => h.toString("hex"))).toEqual(r.threeLeaves.leafHashes);
    const t = buildBatchTree(hashes);
    expect(t.root).toBe(r.threeLeaves.root);
    t.proofs.forEach((p, i) => expect(p.siblings.map((h, j) => ({ hash: h, dir: p.directions[j] }))).toEqual(r.threeLeaves.proofs[i]));
  });
  it("4 leaves", () => {
    const t = buildBatchTree(r.fourLeaves.leafHashes.map((h: string) => Buffer.from(h, "hex")));
    expect(t.root).toBe(r.fourLeaves.root);
    t.proofs.forEach((p, i) => expect(p.siblings.map((h, j) => ({ hash: h, dir: p.directions[j] }))).toEqual(r.fourLeaves.proofs[i]));
  });
});

describe("signed tiered record (ML-DSA-65 known answer)", () => {
  const v = loadVector("signed-tiered.json");
  it("envelope JCS bytes match", () => expect(canonicalize(v.envelope)).toBe(v.canonicalEnvelope));
  it("signature verifies with @noble/post-quantum 0.3.0 verify(publicKey, msg, sig)", () => {
    const ok = ml_dsa65.verify(Buffer.from(v.publicKey, "base64"), new TextEncoder().encode(v.canonicalEnvelope), Buffer.from(v.signature, "hex"));
    expect(ok).toBe(true);
  });
  it("deterministic signing from the seed reproduces the signature bit-for-bit (library upgrade gate)", () => {
    const kp = ml_dsa65.keygen(new Uint8Array(Buffer.from(v.seedHex, "hex")));
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(v.publicKey);
    const sig = ml_dsa65.sign(secretKey("us"), new TextEncoder().encode(v.canonicalEnvelope));
    expect(Buffer.from(sig).toString("hex")).toBe(v.signature);
    expect(v.signature).toHaveLength(6618);
    expect(Buffer.from(v.publicKey, "base64")).toHaveLength(1952);
  });
  it("record leaf, proof and anchor bundle reproduce", () => {
    const rec = v.record;
    const T = batchLeaf(rec.stub.leafMessage).hash;
    expect(T.toString("hex")).toBe(rec.stub.leafHash);
    expect(foldBatch(T, rec.merkle_proof, rec.merkle_proof_directions)).toBe(v.envelope.batch_root);
    expect(computeAggregateRoot(v.anchorBundle.tier1Flushes)).toBe(v.anchorBundle.aggregateRoot);
    expect(JSON.parse(v.anchorMessage).aggregateRoot).toBe(v.anchorBundle.aggregateRoot);
  });
});

describe("signed DAR bundles (tier1-batch and tier2-federation)", () => {
  const v = loadVector("signed-dar.json");
  it("L, anchor data and payload hash", () => {
    const rec = v.tier1Batch.record;
    expect("sha3-256:" + sha3(canonicalize(rec.dar))).toBe(v.L);
    expect(canonicalize(rec.extensions.rubricDar.tiered.data)).toBe(canonicalize(v.data));
    expect(rec.extensions.rubricDar.bridge.hop0.leafMessage.payload.payload_hash_unsalted).toBe(sha256(canonicalize(v.data)));
    expect(batchLeaf(rec.extensions.rubricDar.bridge.hop0.leafMessage).hash.toString("hex")).toBe(v.T);
  });
  it("tier1-batch signature verifies over the rebuilt envelope", () => {
    expect(canonicalize(v.envelope)).toBe(v.canonicalEnvelope);
    const keys = loadVector("test-keys.json").keys;
    expect(ml_dsa65.verify(Buffer.from(keys.sg.publicKey, "base64"), new TextEncoder().encode(v.canonicalEnvelope), Buffer.from(v.tier1Batch.record.signature.signature, "hex"))).toBe(true);
  });
  it("tier2-federation: three signatures over JCS(signedFields)", () => {
    expect(canonicalize(v.signedFields)).toBe(v.canonicalSignedFields);
    const raw = v.tier2Federation.record.signature.raw;
    expect(raw.signatures).toHaveLength(3);
    for (const s of raw.signatures) {
      expect(ml_dsa65.verify(Buffer.from(s.publicKey, "base64"), new TextEncoder().encode(v.canonicalSignedFields), Buffer.from(s.signature, "hex"))).toBe(true);
    }
    expect(v.tier2Federation.record.signature.signature).toBe(JSON.stringify(raw));
  });
});
