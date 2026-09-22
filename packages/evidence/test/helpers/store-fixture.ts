import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashJson, leafHash, type DarCore } from "@0xsims/attest-decision";
import { backfill } from "@0xsims/attest-index";
import { buildMerkleTree, type VerifiableBundle } from "@0xsims/verify";

export interface DarSpec {
  decisionId: string;
  prev: string | null;
  decision: Record<string, unknown>;
  ts: string;
  agentId: string;
  schema?: Record<string, unknown>;
}

/** Construct a DAR core directly (lets tests choose prev for fork/gap cases). */
export function makeDar(spec: DarSpec): DarCore {
  const schema = spec.schema ?? { type: "object" };
  return {
    v: "DAR/0.1",
    decisionId: spec.decisionId,
    agentId: spec.agentId,
    ts: spec.ts,
    prev: spec.prev,
    leafType: "decision",
    schemaHash: hashJson(schema),
    decisionHash: hashJson(spec.decision),
    decision: spec.decision,
  };
}

export interface StoreFixture {
  dir: string;
  storeDir: string;
  indexDir: string;
  bundles: VerifiableBundle[];
  cleanup(): void;
}

/**
 * Anchor a set of DARs into a Merkle tree, write each as a bundle file, and
 * backfill a real SQLite index over the store — so tests exercise real shards.
 */
export function buildStoreFixture(dars: DarCore[]): StoreFixture {
  const dir = mkdtempSync(join(tmpdir(), "rubric-ev-"));
  const storeDir = join(dir, "store");
  const indexDir = join(dir, "index");
  mkdirSync(join(storeDir, "bundles"), { recursive: true });

  const leaves = dars.map(leafHash);
  const { root, proofs } = buildMerkleTree(leaves);

  const bundles = dars.map((dar, i) => {
    const bundle: VerifiableBundle = {
      attestationId: `att-${dar.decisionId}`,
      dar,
      merkleProof: { leaf: leaves[i]!, steps: proofs[i]!, root },
      anchorRef: {
        network: "hedera-testnet",
        topicId: "0.0.1234",
        sequenceNumber: i + 1,
        root,
        consensusTimestamp: "2025-09-22T00:00:00.000Z",
      },
      signature: { alg: "ed25519", keyRef: "key-1", signature: `sig-${dar.decisionId}`, over: root },
    };
    writeFileSync(join(storeDir, "bundles", `${dar.decisionId}.json`), JSON.stringify(bundle));
    return bundle;
  });

  backfill(storeDir, indexDir);

  return { dir, storeDir, indexDir, bundles, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ID = (n: number) => `01J8Z9Q${String(n).padStart(19, "0")}`;
const TS = (sec: number) => `2025-09-22T00:00:${String(sec).padStart(2, "0")}.000Z`;

/** The golden scenario: 3 linear decisions for one agent across two schemas. */
export function goldenDars(): DarCore[] {
  const agentId = "agent://jev/pricing";
  const s1 = { $id: "pricing/v1", type: "object" };
  const s2 = { $id: "pricing/v2", type: "object" };
  return [
    makeDar({ decisionId: ID(1), prev: null, decision: { action: "approve", n: 1 }, ts: TS(1), agentId, schema: s1 }),
    makeDar({ decisionId: ID(2), prev: ID(1), decision: { action: "approve", n: 2 }, ts: TS(2), agentId, schema: s1 }),
    makeDar({ decisionId: ID(3), prev: ID(2), decision: { action: "deny", n: 3 }, ts: TS(3), agentId, schema: s2 }),
  ];
}

export { ID, TS };
