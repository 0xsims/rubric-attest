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

  it("serializes spec-valid number stress values like ES Number::toString", () => {
    expect(
      canonicalize({
        a: 5e-324, // min subnormal double (non-integer)
        b: 0.1 + 0.2, // 0.30000000000000004
        c: 9007199254740991, // MAX_SAFE_INTEGER
        d: -9007199254740991,
        e: 1.5e-300,
        f: -0, // -> "0"
      }),
    ).toBe(
      '{"a":5e-324,"b":0.30000000000000004,"c":9007199254740991,"d":-9007199254740991,"e":1.5e-300,"f":0}',
    );
  });

  it("rejects integers beyond MAX_SAFE_INTEGER (spec §3.3 — carry as strings)", () => {
    expect(() => canonicalize({ n: 9007199254740992 })).toThrow(JcsError); // 2^53
    expect(() => canonicalize({ n: 1e21 })).toThrow(JcsError);
    expect(() => canonicalize({ n: 1.7976931348623157e308 })).toThrow(JcsError); // integer-valued
    // Non-integer floats of any magnitude are fine.
    expect(canonicalize({ n: 5e-324 })).toBe('{"n":5e-324}');
  });

  it("rejects unpaired surrogates (invalid Unicode)", () => {
    expect(() => canonicalize({ s: "\ud83d" })).toThrow(JcsError); // lone high surrogate
    expect(() => canonicalize({ s: "\ude00" })).toThrow(JcsError); // lone low surrogate
    expect(() => canonicalize({ ["\ud83d"]: 1 })).toThrow(JcsError); // in a key too
    // A valid surrogate pair (emoji) is accepted.
    expect(canonicalize({ s: "😀" })).toBe('{"s":"😀"}');
  });

  it("sorts object keys by UTF-16 code unit including surrogate pairs", () => {
    const obj: Record<string, number> = {};
    obj["￿"] = 1;
    obj["\u{1f600}"] = 2; // astral: leading unit 0xD83D < 0xFFFF, so it sorts first
    obj["a"] = 3;
    expect(canonicalize(obj)).toBe('{"a":3,"\u{1f600}":2,"￿":1}');
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

  it("rejects undefined/function/symbol per spec §3.3 (no silent stripping)", () => {
    expect(() => canonicalize({ a: undefined, b: 1 })).toThrow(JcsError);
    expect(() => canonicalize([undefined, 1])).toThrow(JcsError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(JcsError);
    expect(() => canonicalize({ s: Symbol("x") })).toThrow(JcsError);
    // null is valid JSON and is kept.
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });
});
