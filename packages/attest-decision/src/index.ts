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
  type DarBuildInput,
  type DarBuilderDeps,
  type DarMeta,
} from "./dar.js";
export { Spool, DEFAULT_MAX_BYTES, type SpoolRecord, type SpoolOptions } from "./spool.js";
export {
  HttpTransport,
  type Transport,
  type HttpTransportOptions,
} from "./transport.js";
export { Attestor, type AttestorOptions } from "./attestor.js";
