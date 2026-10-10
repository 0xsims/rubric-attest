/**
 * Strict encodings and hashes (spec §4.3, input rules). `Buffer.from(s, "hex")`
 * stops silently at the first bad character (the RUBRIC-SEC-2026-001 class), so
 * every hex or base64 value is checked against a full-match pattern first.
 */
import { createHash } from "node:crypto";
import { ML_DSA65_PUBLIC_KEY_BYTES, ML_DSA65_SIGNATURE_BYTES } from "./constants.js";

export const HEX64_RE = /^[0-9a-f]{64}$/;
export const DAR_LEAF_RE = /^sha3-256:[0-9a-f]{64}$/;
export const SIG_HEX_RE = new RegExp(`^[0-9a-f]{${ML_DSA65_SIGNATURE_BYTES * 2}}$`);
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Mirror consensus timestamp: `<seconds>.<9-digit nanos>`. */
export const CONSENSUS_TS_RE = /^(0|[1-9][0-9]*)\.[0-9]{9}$/;

export function isHex64(v: unknown): v is string {
  return typeof v === "string" && HEX64_RE.test(v);
}

export function isSigHex(v: unknown): v is string {
  return typeof v === "string" && SIG_HEX_RE.test(v);
}

/** Canonical base64 only: the decoded bytes must re-encode to the same string. */
export function decodeBase64Strict(v: unknown): Buffer | null {
  if (typeof v !== "string" || !BASE64_RE.test(v)) return null;
  const buf = Buffer.from(v, "base64");
  return buf.toString("base64") === v ? buf : null;
}

/** An ML-DSA-65 public key in canonical base64, decoding to exactly 1952 bytes. */
export function decodePublicKey(v: unknown): Buffer | null {
  const buf = decodeBase64Strict(v);
  return buf && buf.length === ML_DSA65_PUBLIC_KEY_BYTES ? buf : null;
}

/** Hex that has already passed a full-match pattern. */
export function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

export function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

export function sha3_256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha3-256");
  for (const p of parts) h.update(p);
  return h.digest();
}

export function utf8(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

export function isSafePositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Own-property read, so a JSON key such as `__proto__` cannot reach the prototype. */
export function own(obj: unknown, key: string): unknown {
  return isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** True if `obj` has exactly these own keys. */
export function hasExactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

/** Parse an ISO-8601 instant with an explicit zone; returns epoch ms or null. */
export function parseIsoMs(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** Mirror consensus timestamp to integer nanoseconds. */
export function consensusTsToNs(ts: string): bigint {
  const [s, n] = ts.split(".");
  return BigInt(s ?? "0") * 1_000_000_000n + BigInt(n ?? "0");
}

/** Epoch ms to a mirror timestamp query value `<seconds>.<nanos>`. */
export function msToConsensusTs(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const s = Math.floor(clamped / 1000);
  const nanos = (clamped % 1000) * 1_000_000;
  return `${s}.${String(nanos).padStart(9, "0")}`;
}
