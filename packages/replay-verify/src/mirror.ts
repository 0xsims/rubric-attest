/**
 * Mirror-node paging, the per-chunk origin check, and chunk reassembly
 * (spec §4.3 step 5).
 */
import { MAX_PAGES } from "./constants.js";
import { CONSENSUS_TS_RE, decodeBase64Strict, isPlainObject, own } from "./encoding.js";
import { jcsEqual } from "./jcs.js";
import { getJson, type GuardedFetch, type Sleep } from "./net.js";

export interface ChunkInfo {
  itid: { account_id: string; transaction_valid_start: string; nonce: number; scheduled: boolean };
  number: number;
  total: number;
}

export interface MirrorMessage {
  sequence_number: number;
  consensus_timestamp: string;
  payer_account_id: string;
  message: string;
  topic_id: string | null;
  chunk: ChunkInfo | null;
}

/** Parse one mirror message; null if its shape is unusable (it then cannot count). */
export function parseMirrorMessage(m: unknown): MirrorMessage | null {
  if (!isPlainObject(m)) return null;
  const seq = own(m, "sequence_number");
  const ts = own(m, "consensus_timestamp");
  const payer = own(m, "payer_account_id");
  const message = own(m, "message");
  const topic = own(m, "topic_id");
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) return null;
  if (typeof ts !== "string" || !CONSENSUS_TS_RE.test(ts)) return null;
  if (typeof payer !== "string" || typeof message !== "string") return null;
  let chunk: ChunkInfo | null = null;
  const ci = own(m, "chunk_info");
  if (ci !== undefined && ci !== null) {
    const itid = own(ci, "initial_transaction_id");
    const num = own(ci, "number");
    const total = own(ci, "total");
    const acct = own(itid, "account_id");
    const tvs = own(itid, "transaction_valid_start");
    const nonce = own(itid, "nonce");
    const scheduled = own(itid, "scheduled");
    if (typeof acct !== "string" || typeof tvs !== "string") return null;
    if (typeof num !== "number" || !Number.isSafeInteger(num) || typeof total !== "number" || !Number.isSafeInteger(total)) return null;
    chunk = {
      itid: {
        account_id: acct,
        transaction_valid_start: tvs,
        nonce: typeof nonce === "number" ? nonce : 0,
        scheduled: scheduled === true,
      },
      number: num,
      total,
    };
  }
  return {
    sequence_number: seq,
    consensus_timestamp: ts,
    payer_account_id: payer,
    message,
    topic_id: typeof topic === "string" ? topic : null,
    chunk,
  };
}

export type CollectResult =
  | { ok: true; messages: MirrorMessage[]; pages: number }
  | { ok: false; reason: string; detail: string };

/**
 * Fetch every page of each query (following links.next) and merge by
 * sequence number. Any page failure fails the whole collection: a search that
 * did not see every page cannot rule out a duplicate.
 */
export async function collectMessages(
  gf: GuardedFetch,
  mirror: string,
  firstUrls: string[],
  sleep: Sleep,
): Promise<CollectResult> {
  const bySeq = new Map<number, { parsed: MirrorMessage; raw: unknown }>();
  let pages = 0;
  for (const first of firstUrls) {
    const seen = new Set<string>();
    let url: string | null = first;
    while (url) {
      if (seen.has(url)) return { ok: false, reason: "PAGINATION_LOOP", detail: `links.next repeated ${url}` };
      seen.add(url);
      if (++pages > MAX_PAGES) return { ok: false, reason: "PAGINATION_LIMIT", detail: `more than ${MAX_PAGES} pages` };
      const r = await getJson(gf, url, sleep);
      if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
      const msgs = own(r.json, "messages");
      if (!Array.isArray(msgs)) return { ok: false, reason: "BAD_PAGE", detail: `page has no messages array: ${url}` };
      for (const raw of msgs) {
        const parsed = parseMirrorMessage(raw);
        if (!parsed) continue;
        const prev = bySeq.get(parsed.sequence_number);
        if (prev) {
          if (!jcsEqual(prev.raw, raw)) {
            return { ok: false, reason: "MIRROR_INCONSISTENT", detail: `sequence ${parsed.sequence_number} differs between pages` };
          }
          continue;
        }
        bySeq.set(parsed.sequence_number, { parsed, raw });
      }
      const next = own(own(r.json, "links"), "next");
      if (next === null || next === undefined) url = null;
      else if (typeof next === "string") url = new URL(next, mirror).href;
      else return { ok: false, reason: "BAD_PAGE", detail: "links.next is not a string" };
    }
  }
  return { ok: true, messages: [...bySeq.values()].map((v) => v.parsed).sort((a, b) => a.sequence_number - b.sequence_number), pages };
}

export interface Reassembled {
  sequenceNumber: number;
  consensusTimestamp: string;
  payerAccountId: string;
  body: Record<string, unknown>;
  chunks: number;
}

/**
 * The origin check runs per chunk, BEFORE reassembly: a chunk counts only if
 * its payer is accepted and, when chunk_info is present, equals the account in
 * chunk_info.initial_transaction_id. Every other chunk is dropped first, so a
 * forged chunk can neither join nor spoil a genuine message.
 */
export function chunkPassesOrigin(m: MirrorMessage, acceptPayer: (p: string) => boolean): boolean {
  if (!acceptPayer(m.payer_account_id)) return false;
  if (m.chunk && m.chunk.itid.account_id !== m.payer_account_id) return false;
  return true;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeBody(chunks: MirrorMessage[]): Record<string, unknown> | null {
  const parts: Buffer[] = [];
  for (const c of chunks) {
    const b = decodeBase64Strict(c.message);
    if (!b) return null;
    parts.push(b);
  }
  try {
    const v: unknown = JSON.parse(decoder.decode(Buffer.concat(parts)));
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Rebuild messages from the chunks that pass the origin check. The group key
 * is the payer plus the full initial_transaction_id. A group with an
 * inconsistent total, a repeated chunk number, or any missing chunk 1..total
 * does not count. A message's sequence, timestamp and payer are chunk 1's.
 */
export function reassemble(messages: MirrorMessage[], topic: string, acceptPayer: (p: string) => boolean): Reassembled[] {
  const out: Reassembled[] = [];
  const groups = new Map<string, MirrorMessage[]>();
  for (const m of messages) {
    if (m.topic_id !== null && m.topic_id !== topic) continue;
    if (!chunkPassesOrigin(m, acceptPayer)) continue;
    if (!m.chunk) {
      const body = decodeBody([m]);
      if (body) out.push({ sequenceNumber: m.sequence_number, consensusTimestamp: m.consensus_timestamp, payerAccountId: m.payer_account_id, body, chunks: 1 });
      continue;
    }
    const t = m.chunk.itid;
    const key = JSON.stringify([m.payer_account_id, t.account_id, t.transaction_valid_start, t.nonce, t.scheduled]);
    const g = groups.get(key);
    if (g) g.push(m);
    else groups.set(key, [m]);
  }
  for (const g of groups.values()) {
    const total = g[0]!.chunk!.total;
    if (total < 1 || g.some((c) => c.chunk!.total !== total)) continue;
    const byNum = new Map<number, MirrorMessage>();
    let dup = false;
    for (const c of g) {
      const n = c.chunk!.number;
      if (n < 1 || n > total || byNum.has(n)) { dup = true; break; }
      byNum.set(n, c);
    }
    if (dup || byNum.size !== total) continue;
    const ordered = [...byNum.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    const body = decodeBody(ordered);
    if (!body) continue;
    const first = ordered[0]!;
    out.push({ sequenceNumber: first.sequence_number, consensusTimestamp: first.consensus_timestamp, payerAccountId: first.payer_account_id, body, chunks: total });
  }
  return out.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}
