/**
 * Test helpers: vectors, TEST keys, a synthetic mirror node served through the
 * injected fetch (tests never touch the network), and fixture builders.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";
import { canonicalize } from "../src/jcs.js";
import { KEYS_URLS } from "../src/constants.js";
import type { FetchLike } from "../src/net.js";

export const VEC_DIR = new URL("./vectors/", import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
export const loadVector = (name: string): Json => JSON.parse(readFileSync(new URL(name, VEC_DIR), "utf8"));
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const PINNED = "0.0.3923341";
export const FOREIGN = "0.0.666";
export const TOPIC = "0.0.10416909";
export const MIRROR = "https://mainnet-public.mirrornode.hedera.com";

// ---- TEST keys (derived from public seeds; never real keys) -------------------

const testKeys = loadVector("test-keys.json").keys as Record<string, { region: string; seedHex: string; publicKey: string }>;
const secretCache = new Map<string, Uint8Array>();
export function secretKey(name: string): Uint8Array {
  let sk = secretCache.get(name);
  if (!sk) {
    sk = ml_dsa65.keygen(new Uint8Array(Buffer.from(testKeys[name]!.seedHex, "hex"))).secretKey;
    secretCache.set(name, sk);
  }
  return sk;
}
export const publicKey = (name: string): string => testKeys[name]!.publicKey;
export function sign(name: string, value: unknown): string {
  return Buffer.from(ml_dsa65.sign(secretKey(name), new TextEncoder().encode(canonicalize(value)))).toString("hex");
}

export const REGIONS = ["us", "sg", "jp", "ca", "eu"] as const;

export interface KeysOpts {
  anchorPayers?: unknown; // undefined = omit the field
  override?: Partial<Record<string, string>>; // region -> key name
  extra?: Json[];
}
export function keysFile(o: KeysOpts = {}): Json {
  const signers: Json[] = REGIONS.map((r) => ({
    region: r,
    oracleId: `oracle-${r}`,
    keyId: `test-${r}`,
    algorithm: "ML-DSA-65",
    standard: "FIPS-204",
    securityLevel: "3",
    publicKey: publicKey(o.override?.[r] ?? r),
    createdAt: 1782317308216,
    rotatedAt: "2026-09-07T01:49:27.225Z",
  }));
  const f: Json = { version: "1", format: "rubric-keys/1", updatedAt: "2026-10-10T00:00:00Z", note: "TEST keys file" };
  if (o.anchorPayers !== undefined) f.anchorPayers = o.anchorPayers;
  f.signers = [...signers, ...(o.extra ?? [])];
  f.attestation = { attestationId: "x", payloadSha3: "sha3-256:00", covers: "signers", verify: "https://rubric-protocol.com/v1/verify/x" };
  return f;
}

// ---- synthetic mirror -----------------------------------------------------------

export interface MirrorMsg {
  consensus_timestamp: string;
  message: string;
  payer_account_id: string;
  running_hash: string;
  running_hash_version: number;
  sequence_number: number;
  topic_id: string;
  chunk_info?: Json;
}

export function tsFromMs(ms: number, extraNanos = 0): string {
  const s = Math.floor(ms / 1000);
  const n = (ms % 1000) * 1_000_000 + extraNanos;
  return `${s}.${String(n).padStart(9, "0")}`;
}

export function single(body: string, seq: number, ts: string, payer = PINNED, withChunkInfo = false): MirrorMsg {
  const m: MirrorMsg = {
    consensus_timestamp: ts,
    message: Buffer.from(body, "utf8").toString("base64"),
    payer_account_id: payer,
    running_hash: "AA==",
    running_hash_version: 3,
    sequence_number: seq,
    topic_id: TOPIC,
  };
  if (withChunkInfo) {
    m.chunk_info = { initial_transaction_id: { account_id: payer, nonce: 0, scheduled: false, transaction_valid_start: ts }, number: 1, total: 1 };
  }
  return m;
}

/** Split a body into 1024-byte chunks, as the SDK does; returns chunks in chunk order. */
export function chunked(body: string, seqs: number[], tsMs: number, payer = PINNED, itidAccount = payer, validStart = "1791594000.000000001"): MirrorMsg[] {
  const bytes = Buffer.from(body, "utf8");
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 1024) parts.push(bytes.subarray(i, i + 1024));
  if (parts.length !== seqs.length) throw new Error(`body needs ${parts.length} chunks, got ${seqs.length} seqs`);
  return parts.map((p, i) => ({
    consensus_timestamp: tsFromMs(tsMs, seqs[i]!),
    message: p.toString("base64"),
    payer_account_id: payer,
    running_hash: "AA==",
    running_hash_version: 3,
    sequence_number: seqs[i]!,
    topic_id: TOPIC,
    chunk_info: { initial_transaction_id: { account_id: itidAccount, nonce: 0, scheduled: false, transaction_valid_start: validStart }, number: i + 1, total: parts.length },
  }));
}

export interface FakeNet {
  fetch: FetchLike;
  requests: string[];
}

export interface FakeNetOpts {
  messages: MirrorMsg[];
  keys?: Json | null; // null => both keys URLs fail (network error)
  pageSize?: number;
  /** Respond with this status for mirror requests (all attempts). */
  mirrorStatus?: number;
  keysStatus?: number;
  /** Per keys URL, overrides keys/keysStatus: null => network error, a number => that HTTP status, else the JSON body. */
  keysPerUrl?: Record<string, Json | null | number>;
  /** Override links.next with this value on the first page. */
  nextOverride?: string;
}

function parseFilters(u: URL): { field: string; op: string; value: string }[] {
  const out: { field: string; op: string; value: string }[] = [];
  for (const field of ["sequencenumber", "timestamp"]) {
    for (const v of u.searchParams.getAll(field)) {
      const [op, value] = v.includes(":") ? [v.slice(0, v.indexOf(":")), v.slice(v.indexOf(":") + 1)] : ["eq", v];
      out.push({ field, op: op!, value: value! });
    }
  }
  return out;
}

function cmp(a: string, b: string, field: string): number {
  if (field === "sequencenumber") return Number(a) - Number(b);
  const toNs = (s: string) => { const [x, y = "0"] = s.split("."); return BigInt(x!) * 1_000_000_000n + BigInt(y.padEnd(9, "0")); };
  const d = toNs(a) - toNs(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** A fake mirror + keys host. Honours sequencenumber/timestamp filters, order=asc, limit, and links.next paging. */
export function fakeNet(o: FakeNetOpts): FakeNet {
  const requests: string[] = [];
  const all = [...o.messages].sort((a, b) => a.sequence_number - b.sequence_number);
  let first = true;
  const fetch: FetchLike = async (url) => {
    requests.push(url);
    const u = new URL(url);
    if (KEYS_URLS.includes(url)) {
      if (o.keysPerUrl && url in o.keysPerUrl) {
        const v = o.keysPerUrl[url];
        if (v === null) throw new TypeError("fetch failed (simulated)");
        if (typeof v === "number") return new Response("err", { status: v });
        return Response.json(v);
      }
      if (o.keys === null) throw new TypeError("fetch failed (simulated)");
      if (o.keysStatus) return new Response("err", { status: o.keysStatus });
      return Response.json(o.keys);
    }
    if (o.mirrorStatus) return new Response("err", { status: o.mirrorStatus });
    const filters = parseFilters(u);
    const limit = Math.min(Number(u.searchParams.get("limit") ?? 25), o.pageSize ?? 100);
    const rows = all.filter((m) =>
      filters.every((f) => {
        const v = f.field === "sequencenumber" ? String(m.sequence_number) : m.consensus_timestamp;
        const c = cmp(v, f.value, f.field);
        return f.op === "gte" ? c >= 0 : f.op === "lte" ? c <= 0 : f.op === "gt" ? c > 0 : f.op === "lt" ? c < 0 : c === 0;
      }),
    );
    const page = rows.slice(0, limit);
    let next: string | null = null;
    if (rows.length > limit) {
      const last = page[page.length - 1]!;
      const q = new URLSearchParams();
      for (const f of filters) if (!(f.field === "sequencenumber" && f.op === "gt")) q.append(f.field, `${f.op}:${f.value}`);
      q.append("sequencenumber", `gt:${last.sequence_number}`);
      q.set("order", "asc");
      q.set("limit", String(u.searchParams.get("limit") ?? 25));
      next = `${u.pathname}?${q.toString().replace(/%3A/g, ":")}`;
    }
    if (first && o.nextOverride !== undefined) { next = o.nextOverride; }
    first = false;
    return Response.json({ messages: page, links: { next } });
  };
  return { fetch, requests };
}

export const noSleep = async (): Promise<void> => {};

// ---- fixtures from the vectors ------------------------------------------------------

export function msOf(iso: string): number {
  return Date.parse(iso);
}

/** The signed tiered vector, plus a genuine anchor message on the fake mirror. */
export function tieredFixture(): { record: Json; bundle: Json; body: string; anchorTsMs: number; messages: MirrorMsg[] } {
  const v = loadVector("signed-tiered.json");
  const record = clone(v.record);
  const bundle = clone(v.anchorBundle);
  const body: string = v.anchorMessage;
  const anchorTsMs = msOf(bundle.anchoredAt) + 1500;
  return { record, bundle, body, anchorTsMs, messages: [single(body, 309001, tsFromMs(anchorTsMs))] };
}

export function darFixture(kind: "tier1Batch" | "tier2Federation"): { record: Json; bundle: Json; body: string; anchorTsMs: number; messages: MirrorMsg[] } {
  const v = loadVector("signed-dar.json")[kind];
  const record = clone(v.record);
  const bundle = clone(v.anchorBundle);
  const body: string = v.anchorMessage;
  const anchorTsMs = msOf(bundle.anchoredAt) + 1200;
  return { record, bundle, body, anchorTsMs, messages: [single(body, 309050, tsFromMs(anchorTsMs))] };
}

/** Noise: unrelated genuine and foreign messages spread over a window, for paging. */
export function noise(startSeq: number, count: number, startMs: number, stepMs: number): MirrorMsg[] {
  const out: MirrorMsg[] = [];
  for (let i = 0; i < count; i++) {
    const body = JSON.stringify({ type: "RUBRIC_TIER2_ANCHOR", anchorId: `noise-${i}`, aggregateRoot: "0".repeat(64) });
    out.push(single(body, startSeq + i, tsFromMs(startMs + i * stepMs), i % 2 ? FOREIGN : PINNED));
  }
  return out;
}

/** Anchor message body built the way attestation-publisher.ts:389-428 builds it. */
export function anchorBody(b: Json, overrides: Json = {}, publishedAt = "2026-10-10T01:00:30.412Z"): string {
  return JSON.stringify({
    type: "RUBRIC_TIER2_ANCHOR",
    schemaVersion: "rubric-anchor/2",
    treeVersion: 3,
    alg: {
      canonicalization: "JCS/RFC8785",
      zk: "Poseidon2-BN254",
      levels: {
        batch: { hash: "SHA-256", domainSeparation: "RFC6962", merkleOdd: "promote" },
        aggregate: { hash: "SHA3-256", domainSeparation: "RFC6962", merkleOdd: "promote" },
        wrap: { hash: "SHA3-256", domainSeparation: "none", merkleOdd: "self-pair" },
      },
    },
    anchorId: b.attestationId,
    aggregateRoot: b.aggregateRoot,
    tier1Count: b.tier1Flushes.length,
    totalItems: b.totalItems,
    anchoredAt: publishedAt,
    ...overrides,
  });
}

export const sha256hex = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
