/**
 * @rubric/verify — the x402-gated decision-verify route (tasks/P4.md).
 *
 * A framework-agnostic Handler that, once payment is present, verifies a DAR
 * against its Merkle inclusion proof, HCS anchor ref, and service signature
 * (surfacing a drift flag), or produces a chain-check continuity report.
 */
export { createDecisionVerifyRoute, DECISION_VERIFY_PATH, type VerifyRouteDeps } from "./route.js";
export { gate, X402_PAYMENT_HEADER, type GateOptions, type PaymentVerifier, type PaymentResult } from "./gate.js";
export {
  svcSend402,
  buildBazaarBlob,
  settlementBlob,
  type BazaarConfig,
  type BazaarBlob,
  type SettlementBlob,
} from "./bazaar.js";
export { assembleVerification } from "./verify.js";
export { chainCheck } from "./chain.js";
export { verifyMerkleProof, buildMerkleTree, nodeHash } from "./merkle.js";
export { json, toNodeListener, type VerifyRequest, type VerifyResponse, type Handler } from "./http.js";
export type {
  IndexPort,
  StorePort,
  SignatureVerifier,
  SignatureResult,
  VerifiableBundle,
  VerificationResult,
  VerifyStatus,
  MerkleProof,
  MerkleProofStep,
  AnchorRef,
  BatchSignature,
  ContinuityReport,
  ChainBranch,
  ChainGap,
  IndexRow,
} from "./ports.js";
