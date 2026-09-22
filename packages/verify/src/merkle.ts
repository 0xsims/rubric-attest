/**
 * Merkle inclusion proofs over SHA3-256 (tasks/P4.md; interior-node hashing is
 * defined by the attestation service per spec/dar-0.1.md §4.3). Leaves are DAR
 * leaf hashes; interior nodes are domain-separated to prevent second-preimage
 * ambiguity between leaves and internal nodes.
 */
import { sha3_256, type HashString } from "@rubric-protocol/attest-decision";
import type { MerkleProofStep } from "./ports.js";

const NODE_DOMAIN = "rubric-merkle-node/1\n";

/** Hash an interior node from its ordered children. */
export function nodeHash(left: HashString, right: HashString): HashString {
  return sha3_256(`${NODE_DOMAIN}${left}\n${right}`);
}

/** Fold a leaf up through its proof steps and check it reproduces `root`. */
export function verifyMerkleProof(leaf: HashString, steps: MerkleProofStep[], root: HashString): boolean {
  let acc = leaf;
  for (const step of steps) {
    acc = step.position === "left" ? nodeHash(step.sibling, acc) : nodeHash(acc, step.sibling);
  }
  return acc === root;
}

/**
 * Build a Merkle root and an inclusion proof for every leaf. Odd levels promote
 * the last node by pairing it with itself. Utility for constructing anchored
 * bundles (and test fixtures); the route only needs verifyMerkleProof.
 */
export function buildMerkleTree(leaves: HashString[]): { root: HashString; proofs: MerkleProofStep[][] } {
  if (leaves.length === 0) throw new Error("merkle: cannot build a tree over zero leaves");

  const proofs: MerkleProofStep[][] = leaves.map(() => []);
  // indexAtLevel[i] tracks where original leaf i currently sits in `level`.
  let level = leaves.slice();
  let positions = leaves.map((_, i) => i);

  while (level.length > 1) {
    const next: HashString[] = [];
    const nextPositions = positions.map(() => 0);
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : level[i]!; // promote odd tail
      const parent = nodeHash(left, right);
      const parentIdx = next.length;
      next.push(parent);
      for (let li = 0; li < positions.length; li++) {
        if (positions[li] === i) {
          proofs[li]!.push({ sibling: right, position: "right" });
          nextPositions[li] = parentIdx;
        } else if (positions[li] === i + 1) {
          proofs[li]!.push({ sibling: left, position: "left" });
          nextPositions[li] = parentIdx;
        }
      }
    }
    level = next;
    positions = nextPositions;
  }

  return { root: level[0]!, proofs };
}
