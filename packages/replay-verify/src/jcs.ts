/**
 * JCS (RFC 8785) with the semantics of rubric-protocol `src/verify/canonical.ts:33`:
 * keys sorted by UTF-16 code units, numbers as `String(n)` (-0 → "0"), only
 * `"`, `\` and U+0000..U+001F escaped, undefined-valued properties omitted.
 *
 * One deliberate difference: a lone UTF-16 surrogate is rejected. canonical.ts
 * would emit it raw and `utf8` encoding would replace it with U+FFFD, so two
 * different strings could give the same signed bytes. The verifier reports
 * such input as UNSUPPORTED (JCS_UNREPRESENTABLE) instead of guessing.
 */

export class JcsError extends Error {
  constructor(message: string) {
    super(`JCS: ${message}`);
    this.name = "JcsError";
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new JcsError("string contains a lone surrogate");
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20) {
      switch (c) {
        case 0x08: out += "\\b"; break;
        case 0x09: out += "\\t"; break;
        case 0x0a: out += "\\n"; break;
        case 0x0c: out += "\\f"; break;
        case 0x0d: out += "\\r"; break;
        default: out += "\\u" + c.toString(16).padStart(4, "0");
      }
    } else if (c === 0x22) {
      out += '\\"';
    } else if (c === 0x5c) {
      out += "\\\\";
    } else {
      out += s[i];
    }
  }
  return out + '"';
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new JcsError("non-finite number");
      if (Object.is(value, -0)) return "0";
      return String(value);
    case "string":
      return serializeString(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map((v) => serialize(v)).join(",") + "]";
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const v = obj[key];
        if (v === undefined) continue;
        parts.push(serializeString(key) + ":" + serialize(v));
      }
      return "{" + parts.join(",") + "}";
    }
    default:
      throw new JcsError(`unsupported value type: ${typeof value}`);
  }
}

/** Canonicalize a JSON value to its RFC 8785 string. Throws JcsError. */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

/** UTF-8 bytes of the canonical form. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(serialize(value), "utf8");
}

/** Structural equality of two JSON values, by canonical form. Throws JcsError. */
export function jcsEqual(a: unknown, b: unknown): boolean {
  return serialize(a) === serialize(b);
}
