import { DarBuilder, leafHash, type DarCore, type HashString } from "@rubric/attest-decision";
import { buildMerkleTree } from "../../src/merkle.js";
import type {
  BatchSignature,
  IndexPort,
  IndexRow,
  SignatureVerifier,
  StorePort,
  VerifiableBundle,
} from "../../src/index.js";

const FIXED_MS = 1_758_499_800_000;

/** Build a deterministic set of chained DARs for one agent. */
export function makeDars(
  agentId: string,
  decisions: Record<string, unknown>[],
  schema: Record<string, unknown> = { type: "object" },
): DarCore[] {
  let n = 0;
  const builder = new DarBuilder({
    newDecisionId: () => `01J8Z9Q${String(++n).padStart(19, "0")}`,
    now: () => FIXED_MS,
  });
  return decisions.map((d) => builder.build({ agentId, decision: d, schema }));
}

export interface Fixture {
  bundles: VerifiableBundle[];
  index: IndexPort;
  store: StorePort;
  rows: IndexRow[];
  root: HashString;
}

const bundlePathFor = (decisionId: string) => `bundles/${decisionId}.json`;

/** Anchor a set of DARs into a Merkle tree and expose mock index + store ports. */
export function buildFixture(dars: DarCore[]): Fixture {
  const leaves = dars.map(leafHash);
  const { root, proofs } = buildMerkleTree(leaves);

  const bundles: VerifiableBundle[] = dars.map((dar, i) => ({
    attestationId: `att-${dar.decisionId}`,
    dar,
    merkleProof: { leaf: leaves[i]!, steps: proofs[i]!, root },
    anchorRef: {
      network: "hedera-testnet",
      topicId: "0.0.1234",
      sequenceNumber: i + 1,
      root,
      consensusTimestamp: "2025-09-22T00:00:01.000Z",
    },
    signature: { alg: "ed25519", keyRef: "key-1", signature: `sig-${dar.decisionId}`, over: root },
  }));

  const rows: IndexRow[] = dars.map((dar) => ({
    attestationId: `att-${dar.decisionId}`,
    decisionId: dar.decisionId,
    agentId: dar.agentId,
    schemaHash: dar.schemaHash,
    decisionHash: dar.decisionHash,
    prev: dar.prev,
    ts: dar.ts,
    leafType: dar.leafType,
    bundlePath: bundlePathFor(dar.decisionId),
  }));

  const byPath = new Map(bundles.map((b) => [bundlePathFor(b.dar.decisionId), b]));
  const byDecisionId = new Map(rows.map((r) => [r.decisionId, r]));
  const byDecisionHash = new Map(rows.map((r) => [r.decisionHash, r]));

  const index: IndexPort = {
    byDecisionId: (id) => byDecisionId.get(id),
    byDecisionHash: (h) => byDecisionHash.get(h),
    agentChain: (agentId) => rows.filter((r) => r.agentId === agentId),
  };
  const store: StorePort = { get: (p) => byPath.get(p) };

  return { bundles, index, store, rows, root };
}

/** A signature verifier that accepts everything (matching `over === root`). */
export const validSignature: SignatureVerifier = (sig: BatchSignature, root) => ({
  verified: sig.over === root,
  keyRef: sig.keyRef,
});

/** A signature verifier that rejects everything. */
export const invalidSignature: SignatureVerifier = (sig: BatchSignature) => ({
  verified: false,
  keyRef: sig.keyRef,
});
