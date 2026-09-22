/**
 * Assemble a decision-verify result from a stored bundle (tasks/P4.md):
 * recompute the hashes, verify the Merkle inclusion proof against the anchored
 * root, check the signature, and surface a drift flag if the record no longer
 * matches its anchored commitment.
 */
import { hashJson, leafHash } from "@rubric/attest-decision";
import { verifyMerkleProof } from "./merkle.js";
import type { SignatureVerifier, VerifiableBundle, VerificationResult } from "./ports.js";

export function assembleVerification(
  bundle: VerifiableBundle,
  verifySignature: SignatureVerifier,
): VerificationResult {
  const { dar, merkleProof, anchorRef } = bundle;

  // 1. The decision payload still hashes to its committed decisionHash.
  const decisionHashOk = hashJson(dar.decision) === dar.decisionHash;

  // 2. The recomputed leaf is the one the proof carries, and the proof folds to
  //    the anchored root.
  const leaf = leafHash(dar);
  const leafMatches = leaf === merkleProof.leaf;
  const proofFolds = verifyMerkleProof(leaf, merkleProof.steps, merkleProof.root);
  const rootMatchesAnchor = merkleProof.root === anchorRef.root;

  // Drift = the record diverges from what was anchored (tampering).
  const drift = !decisionHashOk || !leafMatches || !proofFolds || !rootMatchesAnchor;

  // 3. Service signature over the anchored root.
  const sig = verifySignature(bundle.signature, anchorRef.root);

  return {
    decisionId: dar.decisionId,
    dar,
    merkleProof,
    anchorRef,
    signature: { verified: sig.verified, keyRef: sig.keyRef },
    drift,
    verified: !drift && sig.verified,
  };
}
