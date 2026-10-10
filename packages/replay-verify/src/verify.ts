/**
 * The five replay steps (spec §4.3). Each value is checked against the one
 * before it; no step accepts a value only because it came from an input file.
 * A step that did not run is never PASS.
 */
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";
import {
  ACCOUNT_ID_RE,
  ALG_V3,
  ANCHOR_SCHEMA_VERSION,
  ANCHOR_TREE_VERSION,
  ANCHOR_TYPE,
  DAR_ANCHOR_DATA_SCHEMA,
  DEFAULT_MIRROR,
  DEFAULT_TOPIC,
  FEDERATION_MIN_SIGNERS,
  KEYS_URL,
  SEQ_HINT_SPAN,
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
} from "./constants.js";
import {
  DAR_LEAF_RE,
  UUID_RE,
  consensusTsToNs,
  decodePublicKey,
  hasExactKeys,
  hexToBytes,
  isHex64,
  isPlainObject,
  isSafePositiveInt,
  isSigHex,
  msToConsensusTs,
  own,
  parseIsoMs,
  sha256,
  sha3_256,
  utf8,
} from "./encoding.js";
import { JcsError, canonicalBytes, jcsEqual } from "./jcs.js";
import { effectivePayers, parseKeysFile, type EffectivePayers, type KeysFile, type Signer } from "./keys.js";
import { batchLeaf, computeAggregateRoot, foldBatch, type Direction } from "./merkle.js";
import { collectMessages, reassemble, type Reassembled } from "./mirror.js";
import {
  NetworkGuardError,
  UsageError,
  createGuardedFetch,
  getJson,
  realSleep,
  validateMirror,
  type FetchLike,
  type GuardedFetch,
  type Sleep,
} from "./net.js";
import { InputError, recognizeAnchorBundle, recognizeRecord } from "./record.js";

export type Status = "PASS" | "FAIL" | "UNSUPPORTED" | "UNAVAILABLE";
export type StepName = "signature" | "leaf" | "batch" | "aggregate" | "anchor";
export const STEP_NAMES: readonly StepName[] = ["signature", "leaf", "batch", "aggregate", "anchor"];

export interface StepResult {
  name: StepName;
  status: Status;
  reason: string | null;
  detail: string;
}

export interface AnchorReport {
  anchorId: string | null;
  aggregateRoot: string | null;
  sequenceNumber: number | null;
  consensusTimestamp: string | null;
  payerAccountId: string | null;
  topic: string;
  mirror: string;
  genuineMessages: number;
  searched: { sequenceRanges: [number, number][]; timeWindow: { from: string; to: string } | null } | null;
}

export interface Report {
  verdict: Status;
  verdictDetail: string;
  exitCode: 0 | 1 | 3 | 4;
  recordKind: "tiered" | "dar";
  steps: StepResult[];
  anchor: AnchorReport;
  anchorPayers: { source: "keys-file" | "built-in"; accounts: string[]; attested?: false; warnings: string[] };
  warnings: string[];
}

export interface VerifyOptions {
  /** Parsed --record JSON. */
  record: unknown;
  /** Parsed --anchor-bundle JSON. */
  anchorBundle: unknown;
  /** Parsed --keys JSON. When given, rubric-protocol.com is never contacted. */
  keys?: unknown;
  mirror?: string;
  topic?: string;
  /** Injectable fetch (tests). Every call still goes through the §4.2 guard. */
  fetch?: FetchLike;
  sleep?: Sleep;
}

// ---- step plumbing ------------------------------------------------------------

class Halt extends Error {
  constructor(readonly status: Exclude<Status, "PASS">, readonly reason: string, readonly detail: string) {
    super(detail);
  }
}
function fail(reason: string, detail: string): never {
  throw new Halt("FAIL", reason, detail);
}
function unsupported(reason: string, detail: string): never {
  throw new Halt("UNSUPPORTED", reason, detail);
}
function notRun(detail: string): never {
  throw new Halt("UNSUPPORTED", "NOT_RUN", detail);
}

function toResult(name: StepName, e: unknown): StepResult {
  if (e instanceof Halt) return { name, status: e.status, reason: e.reason, detail: e.detail };
  if (e instanceof JcsError) return { name, status: "UNSUPPORTED", reason: "JCS_UNREPRESENTABLE", detail: e.message };
  throw e;
}

function run(name: StepName, fn: () => string | StepResult): StepResult {
  try {
    const r = fn();
    return typeof r === "string" ? { name, status: "PASS", reason: null, detail: r } : r;
  } catch (e) {
    return toResult(name, e);
  }
}

async function runAsync(name: StepName, fn: () => Promise<string | StepResult>): Promise<StepResult> {
  try {
    const r = await fn();
    return typeof r === "string" ? { name, status: "PASS", reason: null, detail: r } : r;
  } catch (e) {
    return toResult(name, e);
  }
}

function mldsaVerify(publicKey: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  try {
    // @noble/post-quantum 0.3.0: verify(publicKey, msg, sig), pure ML-DSA, empty context.
    return ml_dsa65.verify(new Uint8Array(publicKey), new Uint8Array(msg), new Uint8Array(sig)) === true;
  } catch {
    return false;
  }
}

/**
 * Checks a duplicated field: an absent copy is fine; a present copy must equal
 * the source of truth. A present copy whose source of truth is absent is a
 * mismatch (FAIL DUPLICATE_MISMATCH), not a canonicalization error.
 */
function agree(copy: unknown, truth: unknown, what: string, reason = "DUPLICATE_MISMATCH"): void {
  if (copy === undefined) return;
  if (truth === undefined) fail("DUPLICATE_MISMATCH", `${what} is present but its source of truth is absent`);
  if (!jcsEqual(copy, truth)) fail(reason, `${what} does not match its source of truth`);
}

// ---- DAR core (spec/dar-0.1.md §2, §4.2, §5.1) ------------------------------------

const DAR_REQUIRED_KEYS = ["agentId", "decisionHash", "decisionId", "inputHash", "leafType", "outputHash", "prev", "schemaHash", "ts", "v"] as const;
const DAR_OPTIONAL_KEYS = ["adapter", "schemaRef"] as const;
const DAR_HASH_KEYS = ["schemaHash", "inputHash", "outputHash", "decisionHash"] as const;
/** dar-0.1 §2 `leafType`: "decision", plus the reserved "schema-change" and "checkpoint". */
const DAR_LEAF_TYPES: readonly string[] = ["decision", "schema-change", "checkpoint"];
const DAR_VERSION = "DAR/0.1";
const DAR_TAG_RE = /^DAR\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
/** ULID: 26 chars of Crockford base32; the first char is 0-7 (48-bit timestamp). */
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * Enforce dar-0.1 on the DAR core before its leaf is computed. A `v` other than
 * DAR/0.1 is UNSUPPORTED (DAR_VERSION_UNSUPPORTED): §5.1 forbids claiming leaf
 * verification for an unknown major or a higher minor ("needs-upgrade"), and it
 * is checked first, because a higher minor may carry fields this verifier does
 * not know. Every other violation is FAIL (DAR_CORE_INVALID).
 */
function checkDarCore(dar: unknown): void {
  const bad = (why: string): never => fail("DAR_CORE_INVALID", `DAR core ${why} (spec/dar-0.1.md)`);
  if (!isPlainObject(dar)) bad("is not an object");
  const d = dar as Record<string, unknown>;
  const v = own(d, "v");
  if (typeof v !== "string") bad("v is not a string");
  if (v !== DAR_VERSION) {
    if (DAR_TAG_RE.test(v as string)) unsupported("DAR_VERSION_UNSUPPORTED", `DAR core v ${JSON.stringify(v)}: this verifier knows only ${DAR_VERSION} and must not claim leaf verification (dar-0.1 §5.1, needs-upgrade)`);
    bad(`v ${JSON.stringify(v)} is not a DAR/<major>.<minor> tag`);
  }
  const allowed = new Set<string>([...DAR_REQUIRED_KEYS, ...DAR_OPTIONAL_KEYS]);
  const extra = Object.keys(d).filter((k) => !allowed.has(k));
  if (extra.length > 0) bad(`has field(s) outside the §2 set: ${extra.join(", ")}`);
  const missing = DAR_REQUIRED_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(d, k));
  if (missing.length > 0) bad(`lacks required field(s): ${missing.join(", ")}`);
  for (const k of DAR_HASH_KEYS) {
    if (typeof d[k] !== "string" || !DAR_LEAF_RE.test(d[k] as string)) bad(`${k} is not sha3-256:<64 lowercase hex> (§4.2)`);
  }
  if (typeof d["agentId"] !== "string" || (d["agentId"] as string).length === 0) bad("agentId is not a non-empty string");
  if (typeof d["decisionId"] !== "string" || !ULID_RE.test(d["decisionId"] as string)) bad("decisionId is not a ULID");
  if (typeof d["ts"] !== "string") bad("ts is not a string");
  if (d["prev"] !== null && typeof d["prev"] !== "string") bad("prev is not a string or null");
  if (typeof d["leafType"] !== "string" || !DAR_LEAF_TYPES.includes(d["leafType"] as string)) bad(`leafType ${JSON.stringify(d["leafType"])} is not one of ${DAR_LEAF_TYPES.join(", ")}`);
  if ("schemaRef" in d && typeof d["schemaRef"] !== "string") bad("schemaRef is not a string");
  if ("adapter" in d) {
    const a = d["adapter"];
    if (!isPlainObject(a) || !hasExactKeys(a, ["name", "version"]) || typeof a["name"] !== "string" || typeof a["version"] !== "string") bad("adapter is not {name: string, version: string}");
  }
  const want = "sha3-256:" + sha3_256(canonicalBytes({ schemaHash: d["schemaHash"], inputHash: d["inputHash"], outputHash: d["outputHash"] })).toString("hex");
  if (d["decisionHash"] !== want) bad(`decisionHash is not SHA3-256(JCS({schemaHash, inputHash, outputHash})) = ${want} (§2.1)`);
}

// ---- inputs -------------------------------------------------------------------

interface Flush { flushId: string; forestRoot: string; itemCount: number }
interface BundleInfo {
  attestationId: string;
  anchoredAtMs: number;
  anchoredAt: string;
  flushes: Flush[];
  totalItems: number;
  treeVersion: unknown;
  aggregateRootHint: string;
  seqNum: unknown;
}

function parseBundle(b: Record<string, unknown>): BundleInfo {
  const attestationId = own(b, "attestationId");
  if (typeof attestationId !== "string" || !UUID_RE.test(attestationId)) {
    fail("MALFORMED", "anchor bundle attestationId is not a lowercase UUID (the id key is attestationId, not anchorId)");
  }
  const anchoredAt = own(b, "anchoredAt");
  const anchoredAtMs = parseIsoMs(anchoredAt);
  if (anchoredAtMs === null) fail("MALFORMED", "anchor bundle anchoredAt is not an ISO-8601 instant");
  const raw = own(b, "tier1Flushes") as unknown[];
  if (raw.length === 0) fail("MALFORMED", "anchor bundle tier1Flushes is empty");
  const flushes: Flush[] = raw.map((f, i) => {
    const flushId = own(f, "flushId");
    const forestRoot = own(f, "forestRoot");
    const itemCount = own(f, "itemCount");
    if (typeof flushId !== "string" || flushId.length === 0) fail("MALFORMED", `tier1Flushes[${i}].flushId is not a string`);
    if (!isHex64(forestRoot)) fail("MALFORMED", `tier1Flushes[${i}].forestRoot is not 64 lowercase hex`);
    if (!isSafePositiveInt(itemCount)) fail("MALFORMED", `tier1Flushes[${i}].itemCount is not a positive safe integer`);
    return { flushId: flushId as string, forestRoot: forestRoot as string, itemCount: itemCount as number };
  });
  const aggregateRootHint = own(b, "aggregateRoot");
  if (!isHex64(aggregateRootHint)) fail("MALFORMED", "anchor bundle aggregateRoot is not 64 lowercase hex");
  return {
    attestationId: attestationId as string,
    anchoredAt: anchoredAt as string,
    anchoredAtMs: anchoredAtMs as number,
    flushes,
    totalItems: flushes.reduce((s, f) => s + f.itemCount, 0),
    treeVersion: own(b, "treeVersion"),
    aggregateRootHint: aggregateRootHint as string,
    seqNum: own(b, "seqNum"),
  };
}

const ENVELOPE_KEYS = ["rubric_version", "attestation_type", "batch_root", "batch_size", "flush_id", "issuer_node_region", "issued_at"] as const;
interface Envelope {
  rubric_version: "1.0";
  attestation_type: "tiered";
  batch_root: string;
  batch_size: number;
  flush_id: string;
  issuer_node_region: string;
  issued_at: string;
}

/** Validate a batch envelope: exactly the seven keys of §4.5, typed. */
function checkEnvelope(env: unknown, where: string): Envelope {
  if (!isPlainObject(env) || !hasExactKeys(env, ENVELOPE_KEYS)) fail("ENVELOPE_INVALID", `${where} does not have exactly the seven batch-envelope keys`);
  const e = env as Record<string, unknown>;
  if (e["rubric_version"] !== "1.0" || e["attestation_type"] !== "tiered") fail("ENVELOPE_INVALID", `${where} is not a rubric_version 1.0 tiered envelope`);
  if (!isHex64(e["batch_root"])) fail("MALFORMED", `${where}.batch_root is not 64 lowercase hex`);
  if (!isSafePositiveInt(e["batch_size"])) fail("MALFORMED", `${where}.batch_size is not a positive safe integer`);
  for (const k of ["flush_id", "issuer_node_region", "issued_at"]) {
    if (typeof e[k] !== "string" || (e[k] as string).length === 0) fail("MALFORMED", `${where}.${k} is not a non-empty string`);
  }
  return e as unknown as Envelope;
}

function parseSeqHint(v: unknown): number | null {
  if (isSafePositiveInt(v)) return v;
  if (typeof v === "string" && /^[1-9][0-9]{0,15}$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

// ---- retired-key rule -------------------------------------------------------------

function retiredBlock(s: Signer, anchorTsNs: bigint | null): string | null {
  if (!s.retired) return null;
  if (s.rotatedAtMs === null) return `signer ${s.keyId ?? "?"} is retired with no usable rotatedAt`;
  if (anchorTsNs === null) return `signer ${s.keyId ?? "?"} is retired and no genuine anchor was found, so the anchor time is unknown`;
  if (anchorTsNs < BigInt(s.rotatedAtMs) * 1_000_000n) return null;
  return `signer ${s.keyId ?? "?"} was retired at ${new Date(s.rotatedAtMs).toISOString()}, before the anchor's consensus time`;
}

// ---- main ---------------------------------------------------------------------------

export async function verify(opts: VerifyOptions): Promise<Report> {
  const topic = opts.topic ?? DEFAULT_TOPIC;
  if (!ACCOUNT_ID_RE.test(topic)) throw new UsageError(`--topic ${topic} is not a 0.0.<n> id`);
  const mirror = validateMirror(opts.mirror ?? DEFAULT_MIRROR);
  /** A non-default mirror is the user's choice: noted in the verdict, and never the sole basis for accepting a retired key (§4.4). */
  const customMirror = mirror !== DEFAULT_MIRROR;
  const sleep = opts.sleep ?? realSleep;
  const input = recognizeRecord(opts.record);
  const bundleRaw = recognizeAnchorBundle(opts.anchorBundle);
  const pinned = opts.keys !== undefined;
  let pinnedKeys: KeysFile | null = null;
  if (pinned) {
    pinnedKeys = parseKeysFile(opts.keys);
    if (!pinnedKeys) throw new InputError("--keys is not a keys file (no signers array)");
  }
  const gf: GuardedFetch = createGuardedFetch({ fetch: opts.fetch, mirror, topic, allowKeysUrl: !pinned });
  const rec = input.record;
  const warnings: string[] = [];

  // ---- keys (fetched unless --keys) ----
  let keys: KeysFile | null = pinnedKeys;
  let keysProblem: string | null = null;
  if (!pinned) {
    let r;
    try {
      r = await getJson(gf, KEYS_URL, sleep);
    } catch (e) {
      if (!(e instanceof NetworkGuardError)) throw e;
      r = { ok: false as const, reason: "NETWORK_GUARD", detail: e.message };
    }
    if (!r.ok) keysProblem = `keys file unavailable: ${r.detail}`;
    else {
      keys = parseKeysFile(r.json);
      if (!keys) keysProblem = "fetched keys file has no signers array";
    }
  }
  if (keys && keys.ignoredSigners > 0) warnings.push(`${keys.ignoredSigners} keys-file signer(s) ignored (not ML-DSA-65, bad publicKey, or unknown status)`);
  const payers: EffectivePayers = effectivePayers(pinned ? "pinned" : keys ? "fetched" : "unavailable", keys);

  // ---- shared context ----
  let bundle: BundleInfo | null = null;
  let bundleProblem: Halt | null = null;
  try { bundle = parseBundle(bundleRaw); } catch (e) { if (e instanceof Halt) bundleProblem = e; else throw e; }
  let computedAggregate: string | null = null;
  let T: Buffer | null = null;
  let env: Envelope | null = null;
  let envProblem: Halt | null = null;
  let darFlush: Flush | null = null;
  let darLeafMessage: Record<string, unknown> | null = null;
  let anchorTsNs: bigint | null = null;

  const rd = own(own(rec, "extensions"), "rubricDar");
  const bridge = own(rd, "bridge");
  const hop0 = own(bridge, "hop0");
  const hop1 = own(bridge, "hop1");
  const hop2 = own(bridge, "hop2");

  if (input.kind === "tiered") {
    try { env = checkEnvelope(own(own(rec, "tier1"), "envelope"), "tier1.envelope"); } catch (e) { if (e instanceof Halt) envProblem = e; else throw e; }
  }

  // ---- step 4: batch roots → aggregateRoot (record-independent; computed first) ----
  const step4 = run("aggregate", () => {
    if (bundleProblem) throw bundleProblem;
    const b = bundle!;
    if (b.treeVersion !== ANCHOR_TREE_VERSION) {
      unsupported("TREE_VERSION_UNSUPPORTED", `anchor bundle treeVersion ${JSON.stringify(b.treeVersion)}; v1 implements only treeVersion 3`);
    }
    const totalItems = own(bundleRaw, "totalItems");
    if (totalItems !== undefined && totalItems !== b.totalItems) fail("TOTAL_ITEMS_MISMATCH", "anchor bundle totalItems is not the sum of itemCount");
    const computed = computeAggregateRoot(b.flushes);
    if (computed !== b.aggregateRootHint) {
      fail("AGGREGATE_ROOT_MISMATCH", `computed aggregateRoot ${computed} differs from the bundle's ${b.aggregateRootHint}`);
    }
    if (input.kind === "dar") {
      if (own(hop2, "aggregateRoot") !== computed) fail("AGGREGATE_ROOT_MISMATCH", "DAR hop2.aggregateRoot differs from the computed aggregateRoot");
      if (own(hop2, "treeVersion") !== b.treeVersion) fail("DUPLICATE_MISMATCH", "DAR hop2.treeVersion differs from the anchor bundle's");
    }
    computedAggregate = computed;
    return `aggregateRoot ${computed} recomputed from ${b.flushes.length} tier-1 flush(es) (makeLeafV2 → buildTreeV3 → wrap)`;
  });

  // ---- step 2: leaf ----
  const step2 = run("leaf", () => (input.kind === "tiered" ? leafTiered() : leafDar()));

  function leafTiered(): string {
    const stub = own(rec, "stub");
    const lm = own(stub, "leafMessage");
    const aid = own(rec, "attestation_id");
    if (!isPlainObject(lm)) fail("MALFORMED", "stub.leafMessage is not an object");
    const m = lm as Record<string, unknown>;
    if (typeof aid !== "string") fail("MALFORMED", "attestation_id is not a string");
    if (own(m, "rubric_version") !== "1.0" || own(m, "attestation_type") !== "tiered") fail("LEAF_MESSAGE_INVALID", "leafMessage is not a rubric_version 1.0 tiered message");
    if (own(m, "attestation_id") !== aid || own(stub, "attestationId") !== aid) fail("ATTESTATION_ID_MISMATCH", "attestation_id differs between record, stub and leafMessage");
    const { hash, canonical } = batchLeaf(m);
    const th = hash.toString("hex");
    const stored = own(stub, "leafHash");
    if (!isHex64(stored)) fail("MALFORMED", "stub.leafHash is not 64 lowercase hex");
    if (stored !== th) fail("LEAF_MISMATCH", `recomputed leaf ${th} differs from stub.leafHash ${String(stored)}`);
    agree(own(stub, "treeRoot"), th, "stub.treeRoot", "LEAF_MISMATCH");
    const ph = sha256(utf8(canonical)).toString("hex");
    agree(own(stub, "payloadHash"), ph, "stub.payloadHash", "PAYLOAD_HASH_MISMATCH");
    agree(own(rec, "payload_hash"), ph, "payload_hash", "PAYLOAD_HASH_MISMATCH");
    agree(own(rec, "payload"), own(m, "payload"), "payload");
    T = hash;
    if (!env) notRun("the signed envelope is unusable, so the leaf cannot be bound to it");
    const e = env!;
    if (own(m, "issued_at") !== e.issued_at || own(m, "issuer_node_region") !== e.issuer_node_region) {
      fail("ENVELOPE_BINDING_MISMATCH", "leafMessage issued_at/issuer_node_region differ from the signed envelope");
    }
    agree(own(rec, "issued_at"), e.issued_at, "issued_at", "ENVELOPE_BINDING_MISMATCH");
    agree(own(rec, "issuer_node_region"), e.issuer_node_region, "issuer_node_region", "ENVELOPE_BINDING_MISMATCH");
    return `leaf T = SHA-256(0x00 ‖ JCS(leafMessage)) = ${th}`;
  }

  function leafDar(): string | StepResult {
    const dar = own(rec, "dar");
    checkDarCore(dar);
    const L = "sha3-256:" + sha3_256(canonicalBytes(dar)).toString("hex");
    const mp = own(rec, "merkleProof");
    if (own(mp, "leaf") !== L || own(mp, "root") !== L) fail("LEAF_MISMATCH", `DAR leaf ${L} differs from merkleProof.leaf/root (core edited after signing?)`);
    const steps = own(mp, "steps");
    if (!Array.isArray(steps) || steps.length !== 0) fail("MALFORMED", "merkleProof.steps must be []");
    if (own(own(rec, "anchorRef"), "root") !== L) fail("LEAF_MISMATCH", "anchorRef.root differs from the DAR leaf");
    const v = own(dar, "v");
    const decisionId = own(dar, "decisionId");
    const agentId = own(dar, "agentId");
    if (typeof v !== "string" || typeof decisionId !== "string" || typeof agentId !== "string") fail("MALFORMED", "DAR core v/decisionId/agentId are not strings");
    if (!DAR_LEAF_RE.test(L)) fail("MALFORMED", "DAR leaf is not sha3-256:<64 hex>");
    const data = { schema: DAR_ANCHOR_DATA_SCHEMA, v, decisionId, agentId, leafHash: L };
    const tiered = own(rd, "tiered");
    if (!isPlainObject(own(tiered, "data")) || !jcsEqual(own(tiered, "data"), data)) fail("ANCHOR_DATA_MISMATCH", "extensions.rubricDar.tiered.data is not the anchor data of this DAR core");
    if (!isPlainObject(own(hop0, "data")) || !jcsEqual(own(hop0, "data"), data)) fail("ANCHOR_DATA_MISMATCH", "bridge.hop0.data is not the anchor data of this DAR core");
    const aid = own(rec, "attestationId");
    if (typeof aid !== "string" || own(tiered, "attestationId") !== aid) fail("ATTESTATION_ID_MISMATCH", "bundle attestationId differs from tiered.attestationId");
    const lm = own(hop0, "leafMessage");
    if (!isPlainObject(lm)) fail("MALFORMED", "bridge.hop0.leafMessage is not an object");
    const m = lm as Record<string, unknown>;
    if (own(m, "rubric_version") !== "1.0" || own(m, "attestation_type") !== "tiered") fail("LEAF_MESSAGE_INVALID", "leafMessage is not a rubric_version 1.0 tiered message");
    if (own(m, "attestation_id") !== aid) fail("ATTESTATION_ID_MISMATCH", "leafMessage.attestation_id differs from the bundle attestationId");
    for (const k of ["issued_at", "issuer_node_region"]) {
      if (typeof own(m, k) !== "string" || (own(m, k) as string).length === 0) fail("MALFORMED", `leafMessage.${k} is not a non-empty string`);
    }
    const { hash } = batchLeaf(m);
    const th = hash.toString("hex");
    const stored = own(hop0, "tier1LeafHash");
    if (!isHex64(stored)) fail("MALFORMED", "hop0.tier1LeafHash is not 64 lowercase hex");
    if (stored !== th) fail("TIER1_LEAF_MISMATCH", `recomputed tier-1 leaf ${th} differs from hop0.tier1LeafHash`);
    const payload = own(m, "payload");
    const unsalted = own(payload, "payload_hash_unsalted");
    darLeafMessage = m;
    T = hash;
    if (typeof unsalted === "string") {
      const want = sha256(canonicalBytes(data)).toString("hex");
      if (unsalted !== want) fail("PAYLOAD_MISMATCH", "leafMessage.payload.payload_hash_unsalted is not SHA-256(JCS(anchor data))");
    } else if (typeof own(payload, "payload_commitment") === "string") {
      unsupported("PAYLOAD_COMMITMENT", "leafMessage carries a salted payload_commitment; v1 cannot open it");
    } else {
      fail("MALFORMED", "leafMessage.payload has neither payload_hash_unsalted nor payload_commitment");
    }
    return `DAR leaf L = ${L}; anchor data, payload hash and tier-1 leaf T = ${th} bind to it`;
  }

  // ---- step 3: leaf → signed batch root ----
  const step3 = run("batch", () => (input.kind === "tiered" ? batchTiered() : batchDar()));

  function batchTiered(): string {
    const stub = own(rec, "stub");
    const tier1 = own(rec, "tier1");
    const mp = own(rec, "merkle_proof");
    const md = own(rec, "merkle_proof_directions");
    if (!Array.isArray(mp) || !Array.isArray(md)) fail("MALFORMED", "merkle_proof / merkle_proof_directions are not arrays");
    const sibs = mp as unknown[];
    const dirs = md as unknown[];
    if (sibs.length !== dirs.length) fail("PROOF_LENGTH_MISMATCH", `merkle_proof has ${sibs.length} steps, merkle_proof_directions ${dirs.length}`);
    if (sibs.length > 64) fail("MALFORMED", "proof longer than 64 steps");
    if (!sibs.every(isHex64)) fail("MALFORMED", "a merkle_proof sibling is not 64 lowercase hex");
    if (!dirs.every((d) => d === "L" || d === "R")) fail("MALFORMED", 'a merkle_proof_directions entry is not exactly "L" or "R"');
    agree(own(stub, "merkleProof"), sibs, "stub.merkleProof");
    agree(own(stub, "merkleProofDirections"), dirs, "stub.merkleProofDirections");
    if (!env) notRun("the signed envelope is unusable");
    if (!T) notRun("step 2 produced no leaf");
    const e = env!;
    const folded = foldBatch(T!, sibs as string[], dirs as Direction[]);
    if (folded !== e.batch_root) fail("BATCH_ROOT_MISMATCH", `fold gives ${folded}, the signed envelope.batch_root is ${e.batch_root}`);
    for (const [copy, what] of [[own(rec, "batch_root"), "batch_root"], [own(tier1, "batch_root"), "tier1.batch_root"], [own(stub, "batchRoot"), "stub.batchRoot"], [own(stub, "forestRoot"), "stub.forestRoot"]] as const) {
      agree(copy, e.batch_root, what, "ENVELOPE_BINDING_MISMATCH");
    }
    for (const [copy, what] of [[own(rec, "batch_size"), "batch_size"], [own(tier1, "batch_size"), "tier1.batch_size"], [own(stub, "batchSize"), "stub.batchSize"]] as const) {
      agree(copy, e.batch_size, what, "ENVELOPE_BINDING_MISMATCH");
    }
    if (own(stub, "tier1FlushId") === undefined && own(stub, "flushId") === undefined) fail("MALFORMED", "stub has neither tier1FlushId nor flushId");
    agree(own(stub, "tier1FlushId"), e.flush_id, "stub.tier1FlushId", "ENVELOPE_BINDING_MISMATCH");
    agree(own(stub, "flushId"), e.flush_id, "stub.flushId", "ENVELOPE_BINDING_MISMATCH");
    agree(own(stub, "issuedAt"), e.issued_at, "stub.issuedAt", "ENVELOPE_BINDING_MISMATCH");
    agree(own(stub, "issuerNodeRegion"), e.issuer_node_region, "stub.issuerNodeRegion", "ENVELOPE_BINDING_MISMATCH");
    if (bundleProblem || !bundle) notRun("the anchor bundle is unusable");
    const b = bundle!;
    const hcsAnchorId = own(own(own(rec, "anchors"), "hcs"), "anchor_id");
    if (hcsAnchorId !== undefined && hcsAnchorId !== b.attestationId) fail("ANCHOR_ID_MISMATCH", `record anchors.hcs.anchor_id ${String(hcsAnchorId)} is not the anchor bundle's ${b.attestationId}`);
    const cands = b.flushes.filter((f) => f.flushId === e.flush_id);
    if (cands.length !== 1) fail("FLUSH_NOT_IN_ANCHOR_BUNDLE", `${cands.length} tier1Flushes entries have flushId ${e.flush_id}; exactly one is required`);
    const f = cands[0]!;
    if (f.forestRoot !== e.batch_root || f.itemCount !== e.batch_size) {
      fail("FLUSH_MISMATCH", "the anchor bundle's flush entry disagrees with the signed envelope (forestRoot/itemCount)");
    }
    return `leaf folds through ${sibs.length} step(s) to the signed batch_root ${e.batch_root}; flush ${e.flush_id} is in the anchor bundle`;
  }

  function batchDar(): string {
    const path = own(hop1, "path");
    if (!Array.isArray(path) || path.length > 64) fail("MALFORMED", "hop1.path is not an array of at most 64 steps");
    const steps = path as unknown[];
    const siblings: string[] = [];
    const directions: Direction[] = [];
    for (const s of steps) {
      const sib = own(s, "sibling");
      const dir = own(s, "siblingDirection");
      if (!isHex64(sib)) fail("MALFORMED", "a hop1.path sibling is not 64 lowercase hex");
      if (dir !== "L" && dir !== "R") fail("MALFORMED", 'a hop1.path siblingDirection is not exactly "L" or "R"');
      siblings.push(sib as string);
      directions.push(dir as Direction);
    }
    const batchRoot = own(hop1, "batchRoot");
    if (!isHex64(batchRoot)) fail("MALFORMED", "hop1.batchRoot is not 64 lowercase hex");
    if (!T) notRun("step 2 produced no tier-1 leaf");
    const folded = foldBatch(T!, siblings, directions);
    if (folded !== batchRoot) fail("BATCH_ROOT_MISMATCH", `fold gives ${folded}, hop1.batchRoot is ${String(batchRoot)}`);
    if (bundleProblem || !bundle) notRun("the anchor bundle is unusable");
    const b = bundle!;
    const cands = b.flushes.filter((f) => f.forestRoot === batchRoot);
    if (cands.length !== 1) fail("FLUSH_NOT_IN_ANCHOR_BUNDLE", `${cands.length} tier1Flushes entries have forestRoot ${String(batchRoot)}; exactly one is required`);
    const f = cands[0]!;
    const hopFlush = own(hop2, "flushId");
    if (hopFlush === undefined) fail("MALFORMED", "hop2.flushId is missing");
    if (hopFlush !== null && hopFlush !== f.flushId) fail("FLUSH_MISMATCH", "hop2.flushId differs from the anchor bundle's flush with this batch root");
    if (!jcsEqual(own(hop2, "tier1FlushRoots") ?? null, b.flushes.map((x) => x.forestRoot))) fail("FLUSH_ROOTS_MISMATCH", "hop2.tier1FlushRoots differs from the anchor bundle's roots");
    if (own(hop2, "anchorId") !== b.attestationId) fail("ANCHOR_ID_MISMATCH", `hop2.anchorId ${String(own(hop2, "anchorId"))} is not the anchor bundle's ${b.attestationId}`);
    darFlush = f;
    return `tier-1 leaf folds through ${siblings.length} step(s) to batch root ${String(batchRoot)}; flush ${f.flushId} is in the anchor bundle`;
  }

  // ---- step 5: the anchor message ----
  const anchorReport: AnchorReport = {
    anchorId: bundle ? bundle.attestationId : null,
    aggregateRoot: null,
    sequenceNumber: null,
    consensusTimestamp: null,
    payerAccountId: null,
    topic,
    mirror,
    genuineMessages: 0,
    searched: null,
  };

  const step5 = await runAsync("anchor", async () => {
    if (payers.invalid) unsupported("ANCHOR_PAYERS_INVALID", `keys file anchorPayers is invalid (${payers.invalid}); no fallback`);
    if (bundleProblem || !bundle) notRun("the anchor bundle is unusable");
    const b = bundle!;

    // The record's own topic, when it names one, must be the topic searched.
    // A missing, null or empty value (never filled) is not compared.
    const recTopic = input.kind === "tiered" ? own(own(own(rec, "anchors"), "hcs"), "topic_id") : own(own(rec, "anchorRef"), "topicId");
    const recTopicWhere = input.kind === "tiered" ? "anchors.hcs.topic_id" : "anchorRef.topicId";
    if (recTopic !== undefined && recTopic !== null && recTopic !== "" && recTopic !== topic) {
      fail("TOPIC_MISMATCH", `record ${recTopicWhere} ${JSON.stringify(recTopic)} is not the searched topic ${topic}`);
    }

    // hints: only hints, never trusted
    const hints = new Set<number>();
    const add = (v: unknown) => { const n = parseSeqHint(v); if (n !== null) hints.add(n); };
    if (input.kind === "tiered") {
      const hcs = own(own(rec, "anchors"), "hcs");
      const hintAnchor = own(hcs, "anchor_id");
      if (hintAnchor === undefined || hintAnchor === b.attestationId) add(own(hcs, "sequence_number"));
    } else {
      add(own(own(rec, "anchorRef"), "sequenceNumber"));
      add(own(hop2, "seqNum"));
    }
    add(b.seqNum);

    const base = `${mirror}/api/v1/topics/${topic}/messages`;
    const ranges: [number, number][] = [...hints].sort((x, y) => x - y).map((h) => [Math.max(1, h - SEQ_HINT_SPAN), h + SEQ_HINT_SPAN]);
    const fromMs = b.anchoredAtMs - WINDOW_BEFORE_MS;
    const toMs = b.anchoredAtMs + WINDOW_AFTER_MS;
    const urls = [
      ...ranges.map(([lo, hi]) => `${base}?sequencenumber=gte:${lo}&sequencenumber=lte:${hi}&order=asc&limit=100`),
      `${base}?timestamp=gte:${msToConsensusTs(fromMs)}&timestamp=lte:${msToConsensusTs(toMs)}&order=asc&limit=100`,
    ];
    anchorReport.searched = { sequenceRanges: ranges, timeWindow: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() } };

    let collected;
    try {
      collected = await collectMessages(gf, mirror, urls, sleep);
    } catch (e) {
      if (e instanceof NetworkGuardError) throw new Halt("UNAVAILABLE", "NETWORK_GUARD", e.message);
      throw e;
    }
    if (!collected.ok) throw new Halt("UNAVAILABLE", "MIRROR_UNAVAILABLE", `${collected.reason}: ${collected.detail}`);

    const isAnchor = (m: Reassembled) => own(m.body, "type") === ANCHOR_TYPE;
    const genuine = reassemble(collected.messages, topic, (p) => payers.accounts.includes(p)).filter(isAnchor);
    const matches = genuine.filter((m) => own(m.body, "anchorId") === b.attestationId);
    anchorReport.genuineMessages = matches.length;

    for (const h of hints) {
      const at = genuine.find((m) => m.sequenceNumber === h);
      if (at && own(at.body, "anchorId") !== b.attestationId) {
        fail("ANCHOR_ID_MISMATCH", `the genuine anchor message at hinted sequence ${h} has anchorId ${String(own(at.body, "anchorId"))}, not ${b.attestationId}`);
      }
    }

    if (matches.length === 0) {
      if (payers.fetchedOnly.length > 0) {
        const diag = reassemble(collected.messages, topic, (p) => payers.fetchedOnly.includes(p))
          .filter(isAnchor)
          .filter((m) => own(m.body, "anchorId") === b.attestationId);
        if (diag.length > 0) {
          unsupported("ANCHOR_PAYER_UNPINNED", `an anchor message for ${b.attestationId} exists only from payer(s) ${[...new Set(diag.map((d) => d.payerAccountId))].join(", ")}, listed by the fetched keys file but not in the built-in list`);
        }
      }
      unsupported("ANCHOR_ORIGIN_UNVERIFIED", `no complete RUBRIC_TIER2_ANCHOR message for ${b.attestationId} from a pinned payer (${payers.accounts.join(", ") || "none"}) in the searched range`);
    }

    const earliest = matches.reduce((a, m) => (consensusTsToNs(m.consensusTimestamp) < consensusTsToNs(a.consensusTimestamp) ? m : a));
    anchorTsNs = consensusTsToNs(earliest.consensusTimestamp);
    anchorReport.sequenceNumber = earliest.sequenceNumber;
    anchorReport.consensusTimestamp = earliest.consensusTimestamp;
    anchorReport.payerAccountId = earliest.payerAccountId;
    const earliestRoot = own(earliest.body, "aggregateRoot");
    anchorReport.aggregateRoot = typeof earliestRoot === "string" ? earliestRoot : null;

    const roots = new Set(matches.map((m) => JSON.stringify(own(m.body, "aggregateRoot") ?? null)));
    if (roots.size > 1) fail("DUPLICATE_ANCHOR_CONFLICT", `${matches.length} genuine messages for ${b.attestationId} carry different aggregateRoots`);

    for (const m of matches) {
      const sv = own(m.body, "schemaVersion");
      const tv = own(m.body, "treeVersion");
      const alg = own(m.body, "alg");
      if (sv !== ANCHOR_SCHEMA_VERSION || tv !== ANCHOR_TREE_VERSION) {
        unsupported("ALG_UNSUPPORTED", `message seq ${m.sequenceNumber} has schemaVersion ${JSON.stringify(sv)}, treeVersion ${JSON.stringify(tv)}; v1 accepts only rubric-anchor/2, treeVersion 3`);
      }
      if (isPlainObject(alg) && own(alg, "levels") === undefined) {
        unsupported("ALG_LEGACY_FLAT", `message seq ${m.sequenceNumber} carries the flat pre-August-2026 alg block; unsupported in v1`);
      }
      let same = false;
      try { same = jcsEqual(alg ?? null, ALG_V3); } catch { same = false; }
      if (!same) unsupported("ALG_UNSUPPORTED", `message seq ${m.sequenceNumber} alg block is not exactly the rubric-anchor/2 v3 block`);
    }

    if (!isHex64(earliestRoot)) fail("MALFORMED", "the anchor message aggregateRoot is not 64 lowercase hex");
    if (computedAggregate === null) notRun("step 4 produced no aggregateRoot to match");
    if (earliestRoot !== computedAggregate) {
      fail("AGGREGATE_ROOT_MISMATCH", `the anchor message aggregateRoot ${String(earliestRoot)} is not the computed ${computedAggregate}`);
    }
    for (const m of matches) {
      if (own(m.body, "tier1Count") !== b.flushes.length || own(m.body, "totalItems") !== b.totalItems) {
        fail("ANCHOR_COUNT_MISMATCH", `message seq ${m.sequenceNumber} tier1Count/totalItems disagree with the anchor bundle`);
      }
    }
    const dup = matches.length > 1 ? `; ${matches.length} genuine messages (retries) agree, earliest reported` : "";
    return `genuine anchor from ${earliest.payerAccountId} at seq ${earliest.sequenceNumber}, consensus ${earliest.consensusTimestamp}; aggregateRoot matches${dup}`;
  });

  // ---- step 1: signature (last: it needs the keys, step 4's root and step 5's anchor time) ----
  const step1 = run("signature", () => {
    if (input.kind === "tiered") return signatureTiered();
    return signatureDar();
  });

  /** KEY_RETIRED, or UNAVAILABLE (exit 4) when the anchor time is unknown only because the mirror was unreachable. */
  function retiredHalt(detail: string): never {
    if (anchorTsNs === null && step5.status === "UNAVAILABLE") {
      throw new Halt("UNAVAILABLE", "NOT_RUN", `${detail}; the mirror was unavailable`);
    }
    return unsupported("KEY_RETIRED", detail);
  }

  /**
   * A retired key accepted on the strength of a non-default mirror's consensus
   * time: that mirror is the user's choice and could report any time, so the
   * acceptance is not final (§4.4).
   */
  function untrustedMirrorDetail(signer: Signer): string {
    return `signer ${signer.keyId ?? "?"} is retired; the anchor time that places it before rotatedAt comes from the non-default mirror ${mirror}`;
  }

  /** A retired key counts only before its rotatedAt, judged by the genuine anchor's consensus time from the default mirror. */
  function requireNotRetired(signer: Signer): void {
    const blocked = retiredBlock(signer, anchorTsNs);
    if (blocked) retiredHalt(blocked);
    if (signer.retired && customMirror) unsupported("KEY_RETIRED_UNTRUSTED_MIRROR", untrustedMirrorDetail(signer));
  }

  function keysOrUnavailable(): KeysFile {
    if (!keys) throw new Halt("UNAVAILABLE", "KEYS_UNAVAILABLE", keysProblem ?? "keys file unavailable");
    return keys;
  }

  function signatureTiered(): string {
    if (envProblem) throw envProblem;
    const e = env!;
    const tier1 = own(rec, "tier1");
    const stub = own(rec, "stub");
    const sigHex = own(tier1, "signature");
    const pkB64 = own(tier1, "publicKey");
    if (!isSigHex(sigHex)) fail("MALFORMED", "tier1.signature is not 6618 lowercase hex characters");
    const pk = decodePublicKey(pkB64);
    if (!pk) fail("MALFORMED", "tier1.publicKey is not canonical base64 of 1952 bytes");
    agree(own(rec, "signature"), sigHex, "signature");
    agree(own(rec, "publicKey"), pkB64, "publicKey");
    agree(own(stub, "signature"), sigHex, "stub.signature");
    agree(own(stub, "publicKey"), pkB64, "stub.publicKey");
    const k = keysOrUnavailable();
    const cands = k.signers.filter((s) => s.region === e.issuer_node_region && s.publicKey.equals(pk!));
    if (cands.length === 0) {
      unsupported("KEY_NOT_PUBLISHED", `the keys file lists no ${e.issuer_node_region} signer with the record's publicKey (rotated, unlisted, or self-signed); unsupported until spec §6 O2`);
    }
    const signer = cands.find((s) => !s.retired) ?? cands[0]!;
    if (!mldsaVerify(signer.publicKey, canonicalBytes(e), hexToBytes(sigHex as string))) {
      fail("BAD_SIGNATURE", "ML-DSA-65 signature over JCS(envelope) does not verify under the published key");
    }
    requireNotRetired(signer);
    return `ML-DSA-65 over JCS(batch envelope) verifies under the published ${e.issuer_node_region} key ${signer.keyId ?? ""}${signer.retired ? " (retired; anchor predates rotatedAt)" : ""}`.trim();
  }

  function signatureDar(): string {
    const sig = own(rec, "signature");
    const source = own(sig, "source");
    if (source === "tier2-federation") return signatureFederation(sig);
    if (source === "tier1-batch") return signatureTier1Batch(sig);
    return unsupported("SIGNATURE_SOURCE_UNSUPPORTED", `DAR signature.source ${JSON.stringify(source)} is not tier2-federation or tier1-batch`);
  }

  function signatureFederation(sig: unknown): string {
    const raw = own(sig, "raw");
    if (!isPlainObject(raw)) fail("MALFORMED", "signature.raw is not the federation block");
    const sigStr = own(sig, "signature");
    if (sigStr !== undefined && sigStr !== JSON.stringify(raw)) fail("DUPLICATE_MISMATCH", "signature.signature is not JSON.stringify(signature.raw)");
    const sf = own(raw, "signedFields");
    const SF_KEYS = ["attestation_type", "subject", "anchor_id", "aggregate_root", "tier1_count", "total_items", "anchored_at", "operator_keylist_aggregate_hash", "quorum"];
    if (!isPlainObject(sf) || !hasExactKeys(sf, SF_KEYS)) fail("SIGNED_FIELDS_INVALID", "signedFields does not have exactly the tier-2 federation keys");
    const f = sf as Record<string, unknown>;
    if (f["attestation_type"] !== "threshold-multisig" || f["subject"] !== "tier2-aggregate") fail("SIGNED_FIELDS_INVALID", "signedFields is not a threshold-multisig tier2-aggregate statement");
    const q = f["quorum"];
    if (!isPlainObject(q) || !hasExactKeys(q, ["required", "total", "signer_regions"]) || !isSafePositiveInt(own(q, "required"))) fail("SIGNED_FIELDS_INVALID", "signedFields.quorum is malformed");
    if (bundleProblem || !bundle) notRun("the anchor bundle is unusable");
    const b = bundle!;
    if (f["anchor_id"] !== b.attestationId) fail("SIGNED_FIELDS_MISMATCH", "signedFields.anchor_id is not the anchor bundle's attestationId");
    if (f["tier1_count"] !== b.flushes.length || f["total_items"] !== b.totalItems) fail("SIGNED_FIELDS_MISMATCH", "signedFields tier1_count/total_items disagree with the anchor bundle");
    if (f["anchored_at"] !== b.anchoredAt) fail("SIGNED_FIELDS_MISMATCH", "signedFields.anchored_at is not the anchor bundle's anchoredAt");
    if (computedAggregate === null) notRun("step 4 produced no aggregateRoot");
    if (f["aggregate_root"] !== computedAggregate) fail("SIGNED_FIELDS_MISMATCH", "signedFields.aggregate_root is not the computed aggregateRoot");
    const entries = own(raw, "signatures");
    if (!Array.isArray(entries)) fail("MALFORMED", "federation signatures is not an array");
    const k = keysOrUnavailable();
    const msg = canonicalBytes(f);
    const regions = new Set<string>();
    const keysUsed = new Set<string>();
    let unpublished = 0;
    let retiredBlocked = 0;
    let mirrorBlocked: Signer | null = null;
    for (const entry of entries as unknown[]) {
      const region = own(entry, "region");
      const pkB64 = own(entry, "publicKey");
      const s = own(entry, "signature");
      const pk = decodePublicKey(pkB64);
      if (typeof region !== "string" || !pk || !isSigHex(s)) fail("MALFORMED", "a federation signature entry is malformed");
      const cands = k.signers.filter((x) => x.region === region && x.publicKey.equals(pk!));
      if (cands.length === 0) { unpublished++; continue; }
      const signer = cands.find((x) => !x.retired) ?? cands[0]!;
      if (!mldsaVerify(signer.publicKey, msg, hexToBytes(s as string))) fail("BAD_SIGNATURE", `the ${String(region)} federation signature does not verify under the published key`);
      if (retiredBlock(signer, anchorTsNs)) { retiredBlocked++; continue; }
      if (signer.retired && customMirror) { mirrorBlocked = signer; continue; }
      if (regions.has(region as string) || keysUsed.has(signer.publicKeyB64)) continue;
      regions.add(region as string);
      keysUsed.add(signer.publicKeyB64);
    }
    const need = Math.max(FEDERATION_MIN_SIGNERS, own(q, "required") as number);
    if (regions.size >= need) return `federation: ${regions.size} valid signatures from distinct regions and keys (${[...regions].join(", ")}) over JCS(signedFields)`;
    if (retiredBlocked > 0) retiredHalt(`${retiredBlocked} federation signature(s) are under a retired key that the anchor time does not place before rotatedAt; ${regions.size} of ${need} count`);
    if (mirrorBlocked) unsupported("KEY_RETIRED_UNTRUSTED_MIRROR", `${untrustedMirrorDetail(mirrorBlocked)}; without it ${regions.size} of ${need} count`);
    if (regions.size === 0 && unpublished > 0) unsupported("KEY_NOT_PUBLISHED", "no federation signature is under a key the keys file lists for its region");
    return unsupported("FEDERATION_QUORUM_UNVERIFIED", `${regions.size} of ${need} required federation signatures from distinct published keys verify`);
  }

  function signatureTier1Batch(sig: unknown): string {
    const sigHex = own(sig, "signature");
    if (!isSigHex(sigHex)) fail("MALFORMED", "signature.signature is not 6618 lowercase hex characters");
    // signature.raw is not compared: dar-emit.ts:990 can take it from the /v1/proof
    // response, where it may be an object, so it is not provably the hex (§4.5).
    if (!darLeafMessage) notRun("step 2 produced no leaf message");
    if (!darFlush) notRun("step 3 found no flush for the batch root");
    const lm = darLeafMessage!;
    const fl = darFlush!;
    const envelope = {
      rubric_version: "1.0",
      attestation_type: "tiered",
      batch_root: fl.forestRoot,
      batch_size: fl.itemCount,
      flush_id: fl.flushId,
      issuer_node_region: own(lm, "issuer_node_region"),
      issued_at: own(lm, "issued_at"),
    };
    const msg = canonicalBytes(envelope);
    const k = keysOrUnavailable();
    const region = envelope.issuer_node_region as string;
    const cands = k.signers.filter((s) => s.region === region);
    const verified = cands.filter((s) => mldsaVerify(s.publicKey, msg, hexToBytes(sigHex as string)));
    if (verified.length === 0) {
      unsupported("KEY_NOT_PUBLISHED", `the batch signature verifies under no keys-file ${region} signer (unlisted key or forgery; neither is PASS); unsupported until spec §6 O2`);
    }
    const signer = verified.find((s) => !s.retired) ?? verified[0]!;
    requireNotRetired(signer);
    return `ML-DSA-65 over JCS(rebuilt batch envelope) verifies under the published ${region} key ${signer.keyId ?? ""}`.trim();
  }

  // ---- report ----
  const steps = [step1, step2, step3, step4, step5];
  const anyOf = (s: Status) => steps.some((x) => x.status === s);
  const [verdict, exitCode]: [Status, Report["exitCode"]] = anyOf("FAIL")
    ? ["FAIL", 1]
    : anyOf("UNSUPPORTED")
      ? ["UNSUPPORTED", 3]
      : anyOf("UNAVAILABLE")
        ? ["UNAVAILABLE", 4]
        : ["PASS", 0];
  const notPass = steps.filter((s) => s.status !== "PASS").map((s) => `${s.name}: ${s.status} (${s.reason})`);
  let verdictDetail = notPass.length === 0 ? "all five steps PASS" : notPass.join("; ");
  if (topic !== DEFAULT_TOPIC) {
    const note = `topic ${topic} is not the Rubric anchor topic ${DEFAULT_TOPIC}`;
    verdictDetail += `; NOTE: ${note}`;
    warnings.push(note);
  }
  if (customMirror) {
    const note = `mirror ${mirror} is not the default public mirror ${DEFAULT_MIRROR}; the anchor's payer and consensus time come from it`;
    verdictDetail += `; NOTE: ${note}`;
    warnings.push(note);
  }
  warnings.push(...payers.warnings);

  return {
    verdict,
    verdictDetail,
    exitCode,
    recordKind: input.kind,
    steps,
    anchor: anchorReport,
    anchorPayers: {
      source: payers.source,
      accounts: payers.accounts,
      ...(payers.source === "keys-file" ? { attested: false as const } : {}),
      warnings: payers.warnings,
    },
    warnings,
  };
}
