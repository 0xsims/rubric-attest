/**
 * @rubric-protocol/attest-decision — core SDK (DAR/0.1).
 *
 * Public surface: fire-and-forget attestation (`Attestor`), the DAR builder,
 * JCS canonicalization, SHA3-256 hashing, ULID minting, the durable spool, and
 * transports. See spec/dar-0.1.md and tasks/P1.md.
 */

export {
  DAR_VERSION,
  HASH_ALGORITHM,
  HASH_PREFIX,
  TIERED_ATTEST_PATH,
  API_KEY_ENV,
  SDK_NAME,
  SDK_VERSION,
  SDK_VERSION_HEADER,
  NAMESPACE_RE,
  AGENT_ID_RE,
  RESERVED_AGENT_ID_RE,
  type LeafType,
  type HashString,
  type DarCore,
  type AdapterInfo,
  type TransmitMode,
  type PayloadRecord,
} from "./constants.js";

export { canonicalize, canonicalizeToBytes, JcsError } from "./jcs.js";
export { sha3_256, sha3_256Hex, hashJson } from "./hash.js";
export { ulid, monotonicUlidFactory } from "./ulid.js";
export {
  DarBuilder,
  leafHash,
  canonicalDar,
  decisionHashOf,
  toPayload,
  validateAgentId,
  AgentIdError,
  type DarBuildInput,
  type DarBuilderDeps,
  type DarMeta,
} from "./dar.js";
export { Spool, DEFAULT_MAX_BYTES, type SpoolRecord, type SpoolOptions } from "./spool.js";
export {
  HttpTransport,
  TransportError,
  type Transport,
  type HttpTransportOptions,
  type SendResult,
  type RejectedRecord,
} from "./transport.js";
export {
  Attestor,
  NamespaceMismatchError,
  BatchRejectedError,
  DISCOVERY_AGREEMENT,
  type AttestorOptions,
} from "./attestor.js";
export {
  FileChainHeadStore,
  ChainHeadStoreError,
  type ChainHeadStore,
  type ChainHeadStoreErrorCode,
  type FileChainHeadStoreOptions,
} from "./chain-store.js";
