/**
 * The keys file (spec §2.6) and the anchor-payer precedence rule (§4.3 step 5).
 */
import { ACCOUNT_ID_RE, BUILT_IN_ANCHOR_PAYERS } from "./constants.js";
import { decodePublicKey, isPlainObject, own, parseIsoMs } from "./encoding.js";

export interface Signer {
  region: string;
  keyId: string | null;
  publicKey: Buffer;
  publicKeyB64: string;
  retired: boolean;
  /** For a retired signer: epoch ms of `rotatedAt`, or null if absent/unparseable (never usable). */
  rotatedAtMs: number | null;
}

export type AnchorPayersField =
  | { kind: "absent" }
  | { kind: "invalid"; detail: string }
  | { kind: "valid"; list: string[] };

export interface KeysFile {
  signers: Signer[];
  ignoredSigners: number;
  anchorPayers: AnchorPayersField;
}

/** Validate `anchorPayers`: missing is allowed; otherwise an array of full-match account ids. */
export function parseAnchorPayers(json: Record<string, unknown>): AnchorPayersField {
  if (!Object.prototype.hasOwnProperty.call(json, "anchorPayers")) return { kind: "absent" };
  const v = json["anchorPayers"];
  if (!Array.isArray(v)) return { kind: "invalid", detail: `anchorPayers is ${v === null ? "null" : typeof v}, not an array` };
  for (const p of v) {
    if (typeof p !== "string") return { kind: "invalid", detail: `anchorPayers has a non-string entry (${JSON.stringify(p)})` };
    if (!ACCOUNT_ID_RE.test(p)) return { kind: "invalid", detail: `anchorPayers entry ${JSON.stringify(p)} is not a full-match 0.0.<n> account id` };
  }
  return { kind: "valid", list: [...(v as string[])] };
}

/** Parse a keys file. Returns null if the shape is unusable (no signers array). */
export function parseKeysFile(json: unknown): KeysFile | null {
  if (!isPlainObject(json)) return null;
  const signersRaw = own(json, "signers");
  if (!Array.isArray(signersRaw)) return null;
  const signers: Signer[] = [];
  let ignored = 0;
  for (const s of signersRaw) {
    const region = own(s, "region");
    const algorithm = own(s, "algorithm");
    const pkB64 = own(s, "publicKey");
    const status = own(s, "status");
    const pk = decodePublicKey(pkB64);
    if (typeof region !== "string" || algorithm !== "ML-DSA-65" || !pk || typeof pkB64 !== "string") { ignored++; continue; }
    if (status !== undefined && status !== "retired") { ignored++; continue; } // unknown status: never trusted
    const retired = status === "retired";
    const keyId = own(s, "keyId");
    signers.push({
      region,
      keyId: typeof keyId === "string" ? keyId : null,
      publicKey: pk,
      publicKeyB64: pkB64,
      retired,
      rotatedAtMs: retired ? parseIsoMs(own(s, "rotatedAt")) : null,
    });
  }
  return { signers, ignoredSigners: ignored, anchorPayers: parseAnchorPayers(json) };
}

export interface EffectivePayers {
  /** The list genuine origin is checked against. */
  accounts: string[];
  source: "keys-file" | "built-in";
  /** Payers listed only in a fetched file: diagnostic pool, never genuine. */
  fetchedOnly: string[];
  /** Set when `anchorPayers` is present but invalid: step 5 is UNSUPPORTED, no fallback. */
  invalid: string | null;
  warnings: string[];
}

/**
 * The precedence rule (§4.3 step 5, P7a board ruling 2026-10-10):
 * built-in list is the trust root; a fetched file never widens or shrinks it;
 * only an explicit --keys file with a valid array replaces it.
 */
export function effectivePayers(mode: "pinned" | "fetched" | "unavailable", keys: KeysFile | null): EffectivePayers {
  const builtIn = [...BUILT_IN_ANCHOR_PAYERS];
  const base: EffectivePayers = { accounts: builtIn, source: "built-in", fetchedOnly: [], invalid: null, warnings: [] };
  if (mode === "unavailable" || !keys) {
    if (mode === "unavailable") base.warnings.push("keys file unavailable: anchorPayers not read; built-in list used");
    return base;
  }
  const f = keys.anchorPayers;
  if (f.kind === "invalid") {
    return { ...base, accounts: mode === "pinned" ? [] : builtIn, source: mode === "pinned" ? "keys-file" : "built-in", invalid: f.detail };
  }
  if (f.kind === "absent") return base;
  if (mode === "pinned") {
    const warnings: string[] = [];
    const same = f.list.length === builtIn.length && f.list.every((p, i) => p === builtIn[i]);
    if (!same) {
      warnings.push(
        `--keys anchorPayers ${JSON.stringify(f.list)} differs from the built-in list ${JSON.stringify(builtIn)}; ` +
          "a --keys file is an independent trust root only if it came over a channel other than the rubric-protocol.com host",
      );
    }
    if (f.list.length === 0) warnings.push("--keys anchorPayers is empty: no anchor message can be genuine");
    return { accounts: [...f.list], source: "keys-file", fetchedOnly: [], invalid: null, warnings };
  }
  // fetched
  const warnings: string[] = [];
  for (const p of builtIn) {
    if (!f.list.includes(p)) warnings.push(`fetched anchorPayers omits built-in payer ${p}; the built-in list is still used`);
  }
  const fetchedOnly = f.list.filter((p) => !builtIn.includes(p));
  if (fetchedOnly.length > 0) {
    warnings.push(`fetched anchorPayers lists ${JSON.stringify(fetchedOnly)}, not in the built-in list; their messages are not genuine`);
  }
  return { accounts: builtIn, source: "built-in", fetchedOnly, invalid: null, warnings };
}
