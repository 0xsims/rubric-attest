/**
 * Constants for the replay verifier (spec docs/specs/attestation-index-and-replay.md §4).
 */

/**
 * The built-in anchor-payer list: the trust root for anchor origin (spec D4,
 * §4.3 step 5). A fetched keys file's `anchorPayers` never widens or shrinks
 * it; only an explicit `--keys` file replaces it. Changing it is a change in
 * three places (§2.6): the rubric-web keys file, this list, and the P8
 * `--anchor-payer` default.
 */
export const BUILT_IN_ANCHOR_PAYERS: readonly string[] = Object.freeze(["0.0.3923341"]);

/** Topic `0.0.10416909`: immutable, no submit key, anyone can post (D4). */
export const DEFAULT_TOPIC = "0.0.10416909";

/** The public mirror. `mainnet.mirrornode.hedera.com` is never used (§4.2). */
export const DEFAULT_MIRROR = "https://mainnet-public.mirrornode.hedera.com";

/**
 * The keys file (§4.2 item 1). Fetched from tenprint.ai; rubric-protocol.com
 * serves the identical file and is tried only if tenprint.ai yields no usable
 * keys file. These two URLs are the only operator URLs the verifier may fetch.
 * The `rubric-keys.json` filename is a legacy protocol identifier and stays.
 */
export const KEYS_URL = "https://tenprint.ai/.well-known/rubric-keys.json";
export const KEYS_FALLBACK_URL = "https://rubric-protocol.com/.well-known/rubric-keys.json";
export const KEYS_URLS: readonly string[] = Object.freeze([KEYS_URL, KEYS_FALLBACK_URL]);

/** Operator domains: never a mirror, and only KEYS_URLS may be fetched from them. */
export const OPERATOR_DOMAINS: readonly string[] = Object.freeze(["tenprint.ai", "rubric-protocol.com"]);

/** Mirror hosts that are refused even when given explicitly (§4.2). */
export const FORBIDDEN_MIRROR_HOSTS: readonly string[] = Object.freeze(["mainnet.mirrornode.hedera.com"]);

/** Full-match Hedera account id, no leading zeros, no checksum (§4.3 step 5). */
export const ACCOUNT_ID_RE = /^0\.0\.(?:0|[1-9][0-9]*)$/;

export const ANCHOR_TYPE = "RUBRIC_TIER2_ANCHOR";
export const ANCHOR_SCHEMA_VERSION = "rubric-anchor/2";
export const ANCHOR_TREE_VERSION = 3;

/**
 * The one `alg` block v1 accepts (O8, closed): exactly what rubric-protocol
 * main emits (`attestation-publisher.ts:397-414`). Compared as a whole.
 */
export const ALG_V3 = Object.freeze({
  canonicalization: "JCS/RFC8785",
  zk: "Poseidon2-BN254",
  levels: {
    batch: { hash: "SHA-256", domainSeparation: "RFC6962", merkleOdd: "promote" },
    aggregate: { hash: "SHA3-256", domainSeparation: "RFC6962", merkleOdd: "promote" },
    wrap: { hash: "SHA3-256", domainSeparation: "none", merkleOdd: "self-pair" },
  },
});

/** DAR anchor data schema (`dar-emit.ts:49`). */
export const DAR_ANCHOR_DATA_SCHEMA = "rubric.dar-anchor.v1";

/** Anchor search window around the tier-2 bundle's `anchoredAt` (§4.3 step 5). */
export const WINDOW_BEFORE_MS = 15 * 60 * 1000;
export const WINDOW_AFTER_MS = 60 * 60 * 1000;
/** Sequences fetched on each side of a hinted sequence (a message has at most 20 chunks). */
export const SEQ_HINT_SPAN = 19;

/** Retries per page on 429/5xx/network error (§4.2). */
export const MAX_RETRIES = 5;
export const RETRY_BASE_MS = 500;
export const MAX_PAGES = 500;
export const REQUEST_TIMEOUT_MS = 30_000;

/** Federation quorum floor (`threshold-endpoint.ts`, 3-of-5). */
export const FEDERATION_MIN_SIGNERS = 3;

/** ML-DSA-65 sizes (FIPS 204). */
export const ML_DSA65_PUBLIC_KEY_BYTES = 1952;
export const ML_DSA65_SIGNATURE_BYTES = 3309;
