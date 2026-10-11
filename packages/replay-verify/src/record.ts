/**
 * Input recognition (spec §4.1). A record that is not a tiered warm record or
 * a completed DAR bundle is a usage error (exit 2), not a verification result.
 */
import { isPlainObject, own } from "./encoding.js";

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export type RecordInput =
  | { kind: "tiered"; record: Record<string, unknown> }
  | { kind: "dar"; record: Record<string, unknown> };

function isTieredRecord(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && own(v, "attestation_type") === "tiered" && isPlainObject(own(v, "tier1")) && isPlainObject(own(v, "stub"));
}

function isDarBundle(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && isPlainObject(own(v, "dar")) && isPlainObject(own(own(v, "extensions"), "rubricDar"));
}

/** Recognize the --record input. Throws InputError. */
export function recognizeRecord(json: unknown): RecordInput {
  if (Array.isArray(json)) {
    // Warm files are sometimes arrays (warm-backfill.ts:104-112): exactly one tiered record, or exit 2.
    const tiered = json.filter(isTieredRecord);
    if (tiered.length !== 1) {
      throw new InputError(`--record is a JSON array with ${tiered.length} tiered records; exactly one is required`);
    }
    return { kind: "tiered", record: tiered[0]! };
  }
  if (isDarBundle(json)) {
    const rd = own(own(json, "extensions"), "rubricDar");
    if (own(rd, "state") !== "complete" || !isPlainObject(own(json, "signature")) || !isPlainObject(own(rd, "bridge"))) {
      throw new InputError("--record is a DAR bundle that is not complete (no signature or bridge yet)");
    }
    return { kind: "dar", record: json };
  }
  if (isTieredRecord(json)) return { kind: "tiered", record: json };
  throw new InputError("--record is neither a tiered warm record nor a completed DAR bundle");
}

/** Recognize the --anchor-bundle input. Field checks happen in step 4. Throws InputError. */
export function recognizeAnchorBundle(json: unknown): Record<string, unknown> {
  if (!isPlainObject(json) || !Array.isArray(own(json, "tier1Flushes"))) {
    throw new InputError("--anchor-bundle is not a tier-2 anchor bundle (no tier1Flushes array)");
  }
  return json;
}
