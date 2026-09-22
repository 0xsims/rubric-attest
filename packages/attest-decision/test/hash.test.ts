import { describe, it, expect } from "vitest";
import { sha3_256, sha3_256Hex, hashJson, HASH_PREFIX, canonicalize } from "../src/index.js";

describe("SHA3-256 hashing (FIPS 202)", () => {
  it("matches known NIST test vectors", () => {
    // SHA3-256("") and SHA3-256("abc") are standard published vectors.
    expect(sha3_256Hex("")).toBe(
      "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a",
    );
    expect(sha3_256Hex("abc")).toBe(
      "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532",
    );
  });

  it("prefixes with sha3-256: and produces 64 hex chars", () => {
    const h = sha3_256("abc");
    expect(h.startsWith(HASH_PREFIX)).toBe(true);
    expect(h).toMatch(/^sha3-256:[0-9a-f]{64}$/);
  });

  it("treats string and equivalent UTF-8 bytes identically", () => {
    expect(sha3_256Hex("abc")).toBe(sha3_256Hex(Buffer.from("abc", "utf8")));
  });

  it("hashJson canonicalizes then hashes (spec §3.1)", () => {
    const value = { b: 2, a: 1 };
    expect(hashJson(value)).toBe(sha3_256(canonicalize(value)));
    // Order-independent because canonicalization sorts keys.
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
  });
});
