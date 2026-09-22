/**
 * Ports and wire types for the decision-verify route (tasks/P4.md).
 *
 * The route depends only on these interfaces, so tests inject in-memory mocks
 * for the index and store ("route tests green on mocked index+store").
 */
import type { DarCore, HashString } from "@rubric/attest-decision";
import type { IndexRow } from "@rubric/attest-index";

export type { IndexRow };

/** A Merkle inclusion proof step: a sibling hash and which side it sits on. */
export interface MerkleProofStep {
  sibling: HashString;
  position: "left" | "right";
}

/** Inclusion proof from a leaf up to a published root. */
export interface MerkleProof {
  leaf: HashString;
  steps: MerkleProofStep[];
  root: HashString;
}

/** Reference to the on-chain (HCS) anchor that committed a Merkle root. */
export interface AnchorRef {
  network: string;
  topicId: string;
  sequenceNumber: number;
  root: HashString;
  consensusTimestamp?: string;
}

/** Service signature over an anchored root. */
export interface BatchSignature {
  alg: string;
  keyRef: string;
  signature: string;
  over: HashString; // the root the signature covers
}

/** A stored bundle: the DAR core plus the attestation envelope (spec §6). */
export interface VerifiableBundle {
  attestationId: string;
  dar: DarCore;
  merkleProof: MerkleProof;
  anchorRef: AnchorRef;
  signature: BatchSignature;
}

/** Index port — row lookups by decisionId/decisionHash and per-agent chains. */
export interface IndexPort {
  byDecisionId(decisionId: string): IndexRow | undefined;
  byDecisionHash(decisionHash: string): IndexRow | undefined;
  agentChain(agentId: string): IndexRow[];
}

/** Store port — load a full bundle by its path. */
export interface StorePort {
  get(bundlePath: string): VerifiableBundle | undefined;
}

export interface SignatureResult {
  verified: boolean;
  keyRef: string;
}

/** Verifies a service signature over an anchored root. Injected (mockable). */
export type SignatureVerifier = (signature: BatchSignature, root: HashString) => SignatureResult;

/** The decision-verify result body. */
export interface VerificationResult {
  decisionId: string;
  dar: DarCore;
  merkleProof: MerkleProof;
  anchorRef: AnchorRef;
  signature: SignatureResult;
  /** True when the record no longer matches its anchored commitment (tampering). */
  drift: boolean;
  /** Overall: no drift AND signature verified. */
  verified: boolean;
}

/** A fork point: a decision with more than one child in the chain. */
export interface ChainBranch {
  parent: string;
  children: string[];
}

/** A break where a record's `prev` points at a decision absent from the index. */
export interface ChainGap {
  decisionId: string;
  missingPrev: string;
}

/** Continuity report for an agent's chain (tasks/P4.md). */
export interface ContinuityReport {
  agentId: string;
  count: number;
  genesis: string[]; // decisions with prev === null
  heads: string[]; // tips: not referenced as anyone's prev
  branches: ChainBranch[]; // forks, represented as branches (NOT tampering)
  gaps: ChainGap[];
  /** True iff a single unbroken linear chain (one genesis, one head, no forks/gaps). */
  linear: boolean;
  /** Forks and gaps are structural, not tampering — always false here. */
  tampering: false;
}
