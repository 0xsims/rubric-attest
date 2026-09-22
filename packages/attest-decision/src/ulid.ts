/**
 * ULID (https://github.com/ulid/spec): 48-bit millisecond timestamp + 80 bits
 * of randomness, Crockford base32, 26 chars. Used for `decisionId` (spec §2).
 *
 * A monotonic factory guarantees strictly increasing ids even within the same
 * millisecond (randomness is incremented), so per-agent `prev` chains built from
 * mint order are well-defined.
 */
import { randomFillSync } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (no I,L,O,U)
const TIME_LEN = 10;
const RAND_LEN = 16;

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > 0xffffffffffff) {
    throw new Error(`ulid: time ${ms} out of 48-bit range`);
  }
  let out = "";
  let t = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomDigits(): number[] {
  // Each byte's low 5 bits are uniform over 0..31 (256 is a multiple of 32).
  const bytes = randomFillSync(new Uint8Array(RAND_LEN));
  return Array.from(bytes, (b) => b & 31);
}

function incrementDigits(digits: number[]): number[] {
  const next = digits.slice();
  for (let i = RAND_LEN - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i]!++;
      return next;
    }
    next[i] = 0;
  }
  // Overflow within one millisecond (2^80 ids) — astronomically unlikely.
  return randomDigits();
}

function encodeDigits(digits: number[]): string {
  let out = "";
  for (const d of digits) out += ENCODING[d];
  return out;
}

/**
 * Create a monotonic ULID generator. `now` returns epoch milliseconds
 * (injectable for deterministic tests). If the clock does not advance (or goes
 * backwards) the randomness is incremented to keep ids strictly increasing.
 */
export function monotonicUlidFactory(now: () => number = Date.now): () => string {
  let lastTime = -1;
  let lastRand: number[] = [];
  return function ulid(): string {
    let t = Math.trunc(now());
    if (t <= lastTime) {
      t = lastTime;
      lastRand = incrementDigits(lastRand);
    } else {
      lastTime = t;
      lastRand = randomDigits();
    }
    return encodeTime(t) + encodeDigits(lastRand);
  };
}

/** Default process-wide monotonic ULID generator. */
export const ulid = monotonicUlidFactory();
