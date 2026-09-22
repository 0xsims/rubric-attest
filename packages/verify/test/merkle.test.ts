import { describe, it, expect } from "vitest";
import { sha3_256, type HashString } from "@0xsims/attest-decision";
import { buildMerkleTree, verifyMerkleProof } from "../src/index.js";

const leaf = (s: string): HashString => sha3_256(s);

describe("merkle proofs", () => {
  for (const n of [1, 2, 3, 5, 8, 9]) {
    it(`build + verify round-trips for every leaf (${n} leaves)`, () => {
      const leaves = Array.from({ length: n }, (_, i) => leaf(`L${i}`));
      const { root, proofs } = buildMerkleTree(leaves);
      leaves.forEach((lf, i) => {
        expect(verifyMerkleProof(lf, proofs[i]!, root)).toBe(true);
      });
    });
  }

  it("a single leaf is its own root with an empty proof", () => {
    const { root, proofs } = buildMerkleTree([leaf("only")]);
    expect(proofs[0]).toEqual([]);
    expect(root).toBe(leaf("only"));
  });

  it("rejects a tampered leaf", () => {
    const leaves = [leaf("a"), leaf("b"), leaf("c")];
    const { root, proofs } = buildMerkleTree(leaves);
    expect(verifyMerkleProof(leaf("evil"), proofs[0]!, root)).toBe(false);
  });

  it("rejects a tampered proof step", () => {
    const leaves = [leaf("a"), leaf("b"), leaf("c"), leaf("d")];
    const { root, proofs } = buildMerkleTree(leaves);
    const bad = proofs[0]!.map((s, i) => (i === 0 ? { ...s, sibling: leaf("evil") } : s));
    expect(verifyMerkleProof(leaves[0]!, bad, root)).toBe(false);
  });

  it("throws on zero leaves", () => {
    expect(() => buildMerkleTree([])).toThrow();
  });
});
