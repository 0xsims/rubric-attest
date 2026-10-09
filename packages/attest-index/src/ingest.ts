/**
 * Ingest attestation-index.jsonl into the index (tasks/P6-index.md,
 * docs/specs/attestation-index-and-replay.md §3.5, decision D5).
 *
 * The jsonl is the one canonical index. DAR rows are still built from the DAR
 * bundles (the jsonl has no DAR fields), exactly as `backfill` builds them. The
 * anchor columns come only from the jsonl's anchor-link lines, joined on the
 * row's attestationId: a DAR bundle carries the attestationId of the tiered stub
 * it was bridged into (rubric-protocol dar-emit.ts, including after a reattest).
 *
 * Anchor columns are derived, not fill-only: every run recomputes them for every
 * row from the whole merged link set, and writes a row only when they changed.
 * The jsonl is opened read-only, once, and read to EOF; a trailing partial line
 * is ignored. No network access.
 */
import { closeSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectRows } from "./backfill.js";
import { NO_ANCHORS, shardFileName, type AnchorColumns } from "./schema.js";
import { Shard } from "./shard.js";
import { Index } from "./store.js";

export const CURSOR_FILE = "ingest-cursor.json";

// ---- the §3.2 merge rule ---------------------------------------------------------

const MERGED = ["aggregateRoot", "topic", "hcsConsensusTs"] as const;
type Merged = (typeof MERGED)[number];

interface LinkGroup {
  anchorId: string;
  hcsSequence: string;
  aggregateRoot: string | null;
  topic: string | null;
  hcsConsensusTs: string | null;
}

/** Merged anchor-link state per attestation id, fed lines in file order. */
export class LinkSet {
  /** id -> its groups, in order of each group's first line. */
  private readonly byId = new Map<string, Map<string, LinkGroup>>();
  /** ids whose links conflict: two anchorIds, or two non-null values for one field in one group. */
  readonly conflicted = new Set<string>();
  malformed = 0;

  add(rec: Record<string, unknown>): void {
    const { id, anchorId, hcsSequence } = rec;
    if (typeof id !== "string" || typeof anchorId !== "string" || typeof hcsSequence !== "string"
        || !/^(0|[1-9][0-9]*)$/.test(hcsSequence)) {
      this.malformed++;
      // Fail closed: a link we cannot read for a known id marks it conflicted, so the
      // row never reads as cleanly anchored (or unanchored) from a partial link set.
      if (typeof id === "string") {
        this.conflicted.add(id);
        if (!this.byId.has(id)) this.byId.set(id, new Map());
      }
      return;
    }
    let groups = this.byId.get(id);
    if (!groups) this.byId.set(id, (groups = new Map()));
    const first = groups.values().next().value as LinkGroup | undefined;
    if (first && first.anchorId !== anchorId) this.conflicted.add(id);
    const key = `${anchorId}\n${hcsSequence}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { anchorId, hcsSequence, aggregateRoot: null, topic: null, hcsConsensusTs: null }));
    for (const f of MERGED) {
      const v = rec[f];
      if (typeof v !== "string") continue;
      if (g[f] === null) g[f] = v;
      else if (g[f] !== v) this.conflicted.add(id); // first value kept
    }
  }

  ids(): IterableIterator<string> {
    return this.byId.keys();
  }

  /**
   * The anchor columns for `id`. The anchor is the set of all its hcsSequence
   * groups (retries are not a conflict); a value needed once comes from the
   * lowest sequence. On a conflict the columns hold the first-written values and
   * anchorConflict = 1. Groups of one anchorId that disagree on aggregateRoot or
   * topic are a conflict as well.
   */
  anchorsFor(id: string): AnchorColumns {
    const all = [...(this.byId.get(id)?.values() ?? [])];
    const head = all[0];
    if (!head) return this.conflicted.has(id) ? { ...NO_ANCHORS, anchorConflict: 1 } : NO_ANCHORS;
    const anchorId = head.anchorId;
    const mine = all.filter((g) => g.anchorId === anchorId);
    let conflict = this.conflicted.has(id);
    const firstOf = (f: Merged): string | null => mine.find((g) => g[f] !== null)?.[f] ?? null;
    const aggregateRoot = firstOf("aggregateRoot");
    const topic = firstOf("topic");
    if (mine.some((g) => (g.aggregateRoot !== null && g.aggregateRoot !== aggregateRoot) || (g.topic !== null && g.topic !== topic))) {
      conflict = true;
    }
    const sorted = [...mine].sort((a, b) => cmpDecimal(a.hcsSequence, b.hcsSequence));
    return {
      anchorId,
      aggregateRoot,
      hcsSequences: sorted.map((g) => g.hcsSequence),
      hcsConsensusTs: sorted[0]?.hcsConsensusTs ?? null,
      anchorConflict: conflict ? 1 : 0,
    };
  }
}

function cmpDecimal(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
}

function sameAnchors(a: AnchorColumns, b: AnchorColumns): boolean {
  return a.anchorId === b.anchorId && a.aggregateRoot === b.aggregateRoot && a.hcsConsensusTs === b.hcsConsensusTs
    && a.anchorConflict === b.anchorConflict && JSON.stringify(a.hcsSequences) === JSON.stringify(b.hcsSequences);
}

// ---- reading the jsonl -------------------------------------------------------------

interface Cursor {
  v: 1;
  /** Complete lines read. */
  line: number;
  /** `id` of the last of them (null if it had none). */
  id: string | null;
}

function readCursor(indexDir: string): Cursor | null {
  try {
    const c = JSON.parse(readFileSync(join(indexDir, CURSOR_FILE), "utf8")) as Cursor;
    return Number.isInteger(c?.line) && c.line >= 0 ? c : null;
  } catch {
    return null;
  }
}

function writeCursor(indexDir: string, c: Cursor): void {
  const file = join(indexDir, CURSOR_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(c) + "\n");
  renameSync(tmp, file);
}

/** Calls onLine for each complete line. One open, read to EOF; a trailing partial line is not delivered. */
function forEachLine(path: string, onLine: (line: string, i: number) => void): { lines: number; partial: boolean } {
  const fd = openSync(path, "r");
  const buf = Buffer.allocUnsafe(1 << 20);
  let rest = Buffer.alloc(0);
  let i = 0;
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0; ) {
      let chunk = Buffer.concat([rest, buf.subarray(0, n)]);
      let nl;
      while ((nl = chunk.indexOf(0x0a)) >= 0) {
        onLine(chunk.subarray(0, nl).toString("utf8"), i++);
        chunk = chunk.subarray(nl + 1);
      }
      rest = Buffer.from(chunk);
    }
  } finally {
    closeSync(fd);
  }
  return { lines: i, partial: rest.length > 0 };
}

const idOf = (rec: unknown): string | null => {
  const id = (rec as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
};

// ---- ingest ------------------------------------------------------------------------

export interface IngestResult {
  /** Complete jsonl lines read this run. */
  lines: number;
  /** Lines after the resume cursor (all of them on a full re-ingest). */
  newLines: number;
  /** The cursor was missing or its line no longer had the recorded id. */
  fullReingest: boolean;
  /** A trailing line with no newline (an append in progress) was ignored. */
  partialTrailingLine: boolean;
  attestationLines: number;
  /** Attestation lines with no DAR row: counted, not stored (the jsonl is their index). */
  nonDarAttestationLines: number;
  linkLines: number;
  otherTypedLines: number;
  malformedLines: number;
  bundleFiles: number;
  darRows: number;
  rowsWritten: number;
  failed: number;
  skipped: number;
  /** DAR rows with at least one anchor link. */
  anchoredRows: number;
  /** DAR rows whose anchor columns changed this run. */
  anchorRowsUpdated: number;
  /** DAR rows with anchorConflict = 1. */
  conflicts: number;
  conflictIds: string[];
  days: string[];
}

/** Ingest `jsonlPath` and the DAR bundles under `storeDir` into the index at `indexDir`. */
export function ingest(jsonlPath: string, storeDir: string, indexDir: string): IngestResult {
  // 1. DAR rows from bundles, as backfill does. Opening a shard for writing migrates it to v2.
  const { files, rows, skipped } = collectRows(storeDir);
  const index = new Index(indexDir);
  let written: number, failed: number, days: string[];
  try {
    ({ written, failed } = index.writeBatchResilient(rows));
    days = index.shardDays();
  } finally {
    index.close();
  }
  const darIds = new Set(rows.map((r) => r.attestationId));

  // 2. The jsonl, read-only, once.
  const cursor = readCursor(indexDir);
  const links = new LinkSet();
  let idAtCursor: string | null | undefined;
  let lastId: string | null = null;
  const counts = { attestation: 0, nonDar: 0, newLines: 0, link: 0, other: 0, malformed: 0 };
  const read = forEachLine(jsonlPath, (line, i) => {
    let rec: Record<string, unknown> | null = null;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { /* malformed */ }
    lastId = idOf(rec);
    if (cursor && i === cursor.line - 1) idAtCursor = lastId;
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) { counts.malformed++; return; }
    if (rec.kind === undefined) {
      counts.attestation++;
      if (!darIds.has(lastId ?? "")) counts.nonDar++;
    } else if (rec.kind === "anchor-link") {
      counts.link++;
      links.add(rec);
    } else {
      counts.other++;
    }
  });
  const fullReingest = !cursor || cursor.line > read.lines || (cursor.line > 0 && idAtCursor !== cursor.id);
  const newLines = fullReingest ? read.lines : read.lines - cursor!.line;

  // 3. Recompute every row's anchor columns; write only the ones that changed.
  let anchoredRows = 0;
  let updated = 0;
  const conflictIds: string[] = [];
  for (const day of days) {
    const shard = new Shard(join(indexDir, shardFileName(day)));
    try {
      const changes: [string, AnchorColumns][] = [];
      for (const [id, current] of shard.anchorsByAttestation()) {
        const derived = links.anchorsFor(id);
        if (derived.hcsSequences !== null) anchoredRows++;
        if (derived.anchorConflict === 1) conflictIds.push(id);
        if (!sameAnchors(current, derived)) changes.push([id, derived]);
      }
      if (changes.length > 0) updated += shard.setAnchors(changes);
    } finally {
      shard.close();
    }
  }

  writeCursor(indexDir, { v: 1, line: read.lines, id: read.lines > 0 ? lastId : null });
  conflictIds.sort();
  return {
    lines: read.lines,
    newLines,
    fullReingest,
    partialTrailingLine: read.partial,
    attestationLines: counts.attestation,
    nonDarAttestationLines: counts.nonDar,
    linkLines: counts.link,
    otherTypedLines: counts.other,
    malformedLines: counts.malformed + links.malformed,
    bundleFiles: files,
    darRows: rows.length,
    rowsWritten: written,
    failed,
    skipped,
    anchoredRows,
    anchorRowsUpdated: updated,
    conflicts: conflictIds.length,
    conflictIds: conflictIds.slice(0, 100),
    days,
  };
}
