import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, canonicalizeToBytes, JcsError } from "../src/index.js";

interface Vector {
  name: string;
  in: unknown;
  out: string;
}
const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/jcs-vectors.json", import.meta.url)), "utf8"),
) as { vectors: Vector[] };

describe("JCS canonicalization (RFC 8785)", () => {
  for (const v of vectors.vectors) {
    it(`vector: ${v.name}`, () => {
      expect(canonicalize(v.in)).toBe(v.out);
    });
  }

  it("is order-independent for object keys", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it("escapes control chars as lowercase \\u00XX and uses short escapes", () => {
    // BS/TAB/LF/FF/CR use two-char escapes; other C0 (0x00, 0x1f) use \u00xx;
    // quote and backslash are escaped; forward slash is not.
    const NUL = String.fromCharCode(0x00);
    const US = String.fromCharCode(0x1f);
    const s = `\b\t\n\f\r${NUL}${US}"\\/`;
    expect(canonicalize({ s })).toBe('{"s":"\\b\\t\\n\\f\\r\\u0000\\u001f\\"\\\\/"}');
  });

  it("canonicalizeToBytes returns UTF-8 bytes of the canonical string", () => {
    const value = { ü: 1 };
    expect(canonicalizeToBytes(value)).toEqual(Buffer.from(canonicalize(value), "utf8"));
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ x: NaN })).toThrow(JcsError);
    expect(() => canonicalize(Infinity)).toThrow(JcsError);
    expect(() => canonicalize(-Infinity)).toThrow(JcsError);
  });

  it("rejects bigint and non-plain objects", () => {
    expect(() => canonicalize({ x: 1n })).toThrow(JcsError);
    expect(() => canonicalize(new Date())).toThrow(JcsError);
    expect(() => canonicalize(new Map())).toThrow(JcsError);
  });

  it("mirrors JSON semantics for undefined (omit in object, null in array)", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalize([undefined, 1])).toBe("[null,1]");
  });
});
