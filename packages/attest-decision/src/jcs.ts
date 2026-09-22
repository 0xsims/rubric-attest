/**
 * JCS canonicalization — RFC 8785 (spec/dar-0.1.md §3).
 *
 * We lean on the platform: ECMAScript's Number-to-String and `JSON.stringify`
 * string escaping are byte-for-byte what RFC 8785 mandates (§3.2.2.2/§3.2.2.3),
 * and the default string sort compares by UTF-16 code unit — exactly JCS's key
 * ordering rule. So canonicalization reduces to: recurse, sort object keys, and
 * defer scalar serialization to `JSON.stringify`.
 */

class JcsError extends Error {
  constructor(message: string) {
    super(`JCS: ${message}`);
    this.name = "JcsError";
  }
}

function serialize(v: unknown): string {
  if (v === null) return "null";

  const t = typeof v;

  if (t === "number") {
    if (!Number.isFinite(v as number)) {
      throw new JcsError("non-finite number (NaN/Infinity) is not representable");
    }
    // ES Number::toString === RFC 8785 §3.2.2.3. JSON.stringify(-0) === "0".
    return JSON.stringify(v);
  }

  if (t === "boolean") return v ? "true" : "false";

  // RFC 8785 §3.2.2.2 escaping is exactly JSON.stringify's minimal escaping.
  if (t === "string") return JSON.stringify(v);

  if (t === "bigint") {
    throw new JcsError("bigint is not JSON; carry large integers as strings");
  }

  if (Array.isArray(v)) {
    return "[" + v.map(serializeElement).join(",") + "]";
  }

  if (t === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      // Date, Map, Set, class instances, etc. are not part of the JSON model.
      throw new JcsError("non-plain object is not JSON-canonicalizable");
    }
    const obj = v as Record<string, unknown>;
    // Default sort compares by UTF-16 code unit — the RFC 8785 ordering.
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .map((k) => {
          const val = obj[k];
          rejectNonJson(val, `property '${k}'`);
          return JSON.stringify(k) + ":" + serialize(val);
        })
        .join(",") +
      "}"
    );
  }

  // undefined, function, symbol at the top level.
  throw new JcsError(`unsupported value of type '${t}'`);
}

/**
 * Spec §3.3: `undefined`, functions, and symbols MUST NOT appear in a payload —
 * we reject rather than silently stripping them, so a malformed producer input
 * cannot canonicalize to bytes that differ from the producer's intent.
 */
function rejectNonJson(value: unknown, where: string): void {
  const t = typeof value;
  if (value === undefined || t === "function" || t === "symbol") {
    throw new JcsError(`${where} has non-JSON value of type '${value === undefined ? "undefined" : t}'`);
  }
}

function serializeElement(el: unknown): string {
  rejectNonJson(el, "array element");
  return serialize(el);
}

/** Canonicalize a JSON value to its RFC 8785 (JCS) string form. */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

/** Canonicalize a JSON value to its RFC 8785 (JCS) UTF-8 bytes. */
export function canonicalizeToBytes(value: unknown): Buffer {
  return Buffer.from(serialize(value), "utf8");
}

export { JcsError };
