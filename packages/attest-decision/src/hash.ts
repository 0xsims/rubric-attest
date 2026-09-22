/**
 * SHA3-256 hashing (spec/dar-0.1.md §4). SHA3-256 everywhere — an invariant,
 * not a per-call choice. Hash strings are `sha3-256:<64 lowercase hex>`.
 */
import { createHash } from "node:crypto";
import { HASH_ALGORITHM, HASH_PREFIX, type HashString } from "./constants.js";
import { canonicalizeToBytes } from "./jcs.js";

/** Raw SHA3-256 as lowercase hex (no prefix). */
export function sha3_256Hex(input: string | Uint8Array): string {
  const h = createHash(HASH_ALGORITHM);
  h.update(typeof input === "string" ? Buffer.from(input, "utf8") : input);
  return h.digest("hex");
}

/** SHA3-256 as a prefixed `sha3-256:<hex>` HashString. */
export function sha3_256(input: string | Uint8Array): HashString {
  return `${HASH_PREFIX}${sha3_256Hex(input)}` as HashString;
}

/**
 * Canonicalize (JCS) then hash — the one hashing path (spec §3.1).
 * Returns a prefixed HashString over the RFC 8785 bytes of `value`.
 */
export function hashJson(value: unknown): HashString {
  return sha3_256(canonicalizeToBytes(value));
}
