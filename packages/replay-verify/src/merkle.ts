/**
 * The three `rubric-anchor/2` tree levels (spec §2.5), written from the
 * constructions, not copied from rubric-protocol. Golden vectors generated from
 * rubric-protocol's own code pin them (test/vectors).
 *
 *   batch      leaf SHA-256(0x00 ‖ utf8(JCS(leafMessage))), node SHA-256(0x01 ‖ L ‖ R), odd: promote
 *   aggregate  leaf "sha3-256:" + hex(SHA3-256(utf8(JCS({__leafType, forestRoot, itemCount})))),
 *              tag SHA3-256(0x00 ‖ 32 raw bytes), node SHA3-256(0x01 ‖ L ‖ R), odd: promote
 *   wrap       hex(SHA3-256(utf8(rootHex ‖ rootHex)))   (the 128-char hex string)
 *
 * Only the level specs of ALG_V3 are implemented (O8). There is no V1/V2 tree.
 */
import { canonicalize } from "./jcs.js";
import { HEX64_RE, hexToBytes, sha256, sha3_256, utf8 } from "./encoding.js";

const TAG_LEAF = Buffer.from([0x00]);
const TAG_NODE = Buffer.from([0x01]);

// ---- batch level (spec-merkle.ts) -------------------------------------------

/** Batch leaf T and the canonical message it hashes. Throws JcsError. */
export function batchLeaf(leafMessage: unknown): { hash: Buffer; canonical: string } {
  const canonical = canonicalize(leafMessage);
  return { hash: sha256(TAG_LEAF, utf8(canonical)), canonical };
}

export function batchNode(left: Uint8Array, right: Uint8Array): Buffer {
  return sha256(TAG_NODE, left, right);
}

export type Direction = "L" | "R";

/**
 * Fold a leaf to a batch root. A direction names the SIBLING's side:
 * "L" → H(0x01 ‖ sib ‖ acc), "R" → H(0x01 ‖ acc ‖ sib). Inputs must already be
 * validated (64 lowercase hex, "L"/"R" exactly).
 */
export function foldBatch(leaf: Uint8Array, siblings: readonly string[], directions: readonly Direction[]): string {
  if (siblings.length !== directions.length) throw new Error("proof arrays differ in length");
  let acc: Buffer = Buffer.from(leaf);
  for (let i = 0; i < siblings.length; i++) {
    const sib = hexToBytes(siblings[i]!);
    acc = directions[i] === "L" ? batchNode(sib, acc) : batchNode(acc, sib);
  }
  return acc.toString("hex");
}

/** Build a batch tree (used for tests and vectors): returns root and per-leaf proofs. */
export function buildBatchTree(leaves: readonly Uint8Array[]): {
  root: string;
  proofs: { siblings: string[]; directions: Direction[] }[];
} {
  if (leaves.length === 0) throw new Error("empty tree");
  const levels: Buffer[][] = [leaves.map((l) => Buffer.from(l))];
  while (levels[levels.length - 1]!.length > 1) {
    const level = levels[levels.length - 1]!;
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? batchNode(level[i]!, level[i + 1]!) : level[i]!);
    }
    levels.push(next);
  }
  const proofs = leaves.map((_, leafIndex) => {
    const siblings: string[] = [];
    const directions: Direction[] = [];
    let idx = leafIndex;
    for (let lvl = 0; lvl < levels.length - 1; lvl++) {
      const level = levels[lvl]!;
      const isRight = idx % 2 === 1;
      const sib = isRight ? idx - 1 : idx + 1;
      if (sib < level.length) {
        siblings.push(level[sib]!.toString("hex"));
        directions.push(isRight ? "L" : "R");
      }
      idx = Math.floor(idx / 2);
    }
    return { siblings, directions };
  });
  return { root: levels[levels.length - 1]![0]!.toString("hex"), proofs };
}

// ---- aggregate level (merkle.ts makeLeafV2 + buildTreeV3) -------------------

/** makeLeafV2(flushId, "DOCUMENT_HASH", {forestRoot, itemCount}, "sha3-256").hash. flushId is not hashed. */
export function aggregateLeaf(forestRoot: string, itemCount: number): string {
  const preimage = canonicalize({ __leafType: "DOCUMENT_HASH", forestRoot, itemCount });
  return "sha3-256:" + sha3_256(utf8(preimage)).toString("hex");
}

/** buildTreeV3 root over prefixed leaf hashes. */
export function aggregateTreeRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) throw new Error("empty tree");
  let level = leaves.map((h) => {
    const hex = h.slice(h.lastIndexOf(":") + 1);
    if (!HEX64_RE.test(hex)) throw new Error("aggregate leaf is not 32 bytes of lowercase hex");
    return sha3_256(TAG_LEAF, hexToBytes(hex));
  });
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha3_256(TAG_NODE, level[i]!, level[i + 1]!) : level[i]!);
    }
    level = next;
  }
  return level[0]!.toString("hex");
}

// ---- wrap level (merkle.ts buildForest with one tree) -----------------------

/** SHA3-256 over the UTF-8 of the 128-character string rootHex ‖ rootHex. */
export function wrap(rootHex: string): string {
  return sha3_256(utf8(rootHex + rootHex)).toString("hex");
}

/** aggregateRoot from the tier-1 flushes, in bundle order. */
export function computeAggregateRoot(flushes: readonly { forestRoot: string; itemCount: number }[]): string {
  return wrap(aggregateTreeRoot(flushes.map((f) => aggregateLeaf(f.forestRoot, f.itemCount))));
}
