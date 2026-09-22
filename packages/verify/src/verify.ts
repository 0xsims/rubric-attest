/**
 * Assemble a decision-verify result from a stored bundle (tasks/P4.md).
 *
 * Scope (be honest about what this proves): this checks the bundle's INTERNAL
 * consistency — the decision still hashes to its committed decisionHash, the
 * recomputed leaf is the one the proof carries, the proof folds to the root the
 * bundle claims, and the (caller-supplied) signature verifies. It does NOT
 * contact HCS to confirm the root was actually anchored, nor does it establish
 * that the signing key is trusted. `consistencyVerified` reflects only the
 * former; on-chain anchoring is the job of the (out-of-scope) attestation service.
 */
import { DAR_VERSION, decisionHashOf, leafHash } from "@0xsims/attest-decision";
import { verifyMerkleProof } from "./merkle.js";
import type { SignatureVerifier, VerifiableBundle, VerificationResult, VerifyStatus } from "./ports.js";

const LEAF_TYPES: ReadonlySet<string> = new Set(["decision", "schema-change", "checkpoint"]);
const KNOWN = parseVersion(DAR_VERSION)!; // { major: 0, minor: 1 }

function parseVersion(v: string): { major: number; minor: number } | null {
  const m = /^DAR\/(\d+)\.(\d+)$/.exec(v);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** Spec §5.1 version gate: reject unknown major / bad leafType; needs-upgrade for a newer minor. */
function versionStatus(v: string, leafType: string): VerifyStatus {
  const parsed = parseVersion(v);
  if (!parsed || parsed.major !== KNOWN.major) return "rejected"; // unknown major/format
  if (!LEAF_TYPES.has(leafType)) return "rejected";
  if (parsed.minor > KNOWN.minor) return "needs-upgrade"; // MUST NOT strip-and-rehash a newer minor
  return "ok";
}

export function assembleVerification(
  bundle: VerifiableBundle,
  verifySignature: SignatureVerifier,
): VerificationResult {
  const { dar, merkleProof, anchorRef } = bundle;
  const status = versionStatus(dar.v, dar.leafType);
  const sig = verifySignature(bundle.signature, anchorRef.root);

  const base = {
    decisionId: dar.decisionId,
    dar,
    merkleProof,
    anchorRef,
    signature: { verified: sig.verified, keyRef: sig.keyRef },
  };

  // Do not claim (or compute) leaf verification for a version we can't fully
  // understand — spec §5.1 forbids strip-and-rehash of a newer minor.
  if (status !== "ok") {
    return { ...base, drift: false, status, consistencyVerified: false };
  }

  const decisionHashOk = decisionHashOf(dar.schemaHash, dar.inputHash, dar.outputHash) === dar.decisionHash;
  const leaf = leafHash(dar);
  const leafMatches = leaf === merkleProof.leaf;
  const proofFolds = verifyMerkleProof(leaf, merkleProof.steps, merkleProof.root);
  const rootMatchesAnchor = merkleProof.root === anchorRef.root;
  const drift = !decisionHashOk || !leafMatches || !proofFolds || !rootMatchesAnchor;

  return { ...base, drift, status, consistencyVerified: !drift && sig.verified };
}
