/**
 * Backfill the index from a bundle-store directory (tasks/P2.md).
 *
 * Walks the store for `*.json` bundles and upserts a row per bundle. Idempotent
 * (upsert keyed on attestationId), so re-running is a no-op and the index is
 * fully rebuildable from the bundles alone. `bundlePath` is stored relative to
 * the store root so the index stays portable.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Index } from "./store.js";
import { rowFromBundle, shardKeyForTs, type AttestationBundle, type IndexRow } from "./schema.js";

export interface BackfillResult {
  bundleFiles: number;
  rowsWritten: number;
  /** Bundles that parsed and validated but failed to insert (e.g. a conflicting duplicate decisionId). */
  failed: number;
  /** Files that were not valid bundles (parse error, wrong shape, or bad ts). */
  skipped: number;
  days: string[];
}

function walkJson(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
    }
  }
  out.sort();
  return out;
}

function isBundle(value: unknown): value is AttestationBundle {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  if (typeof b.attestationId !== "string" || b.attestationId.length === 0) return false;
  const d = b.dar as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object") return false;
  // Validate EVERY column the index requires as NOT NULL, so a malformed bundle
  // is skipped up front rather than throwing a NOT NULL error mid-insert.
  const str = (x: unknown) => typeof x === "string";
  return (
    str(d.decisionId) &&
    str(d.agentId) &&
    str(d.ts) &&
    str(d.schemaHash) &&
    str(d.decisionHash) &&
    str(d.leafType) &&
    (d.prev === null || str(d.prev))
  );
}

/** Backfill (or rebuild) the index at `indexDir` from bundles under `storeDir`. */
export function backfill(storeDir: string, indexDir: string): BackfillResult {
  const index = new Index(indexDir);
  try {
    const files = walkJson(storeDir);
    const rows: IndexRow[] = [];
    let skipped = 0;
    for (const file of files) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        skipped++;
        continue;
      }
      if (!isBundle(parsed)) {
        skipped++;
        continue;
      }
      // Reject a ts that has no valid day key here, so grouping can't throw.
      try {
        shardKeyForTs(parsed.dar.ts);
      } catch {
        skipped++;
        continue;
      }
      rows.push(rowFromBundle(parsed, relative(storeDir, file)));
    }
    const { written, failed } = index.writeBatchResilient(rows);
    return {
      bundleFiles: files.length,
      rowsWritten: written,
      failed,
      skipped,
      days: index.shardDays(),
    };
  } finally {
    index.close();
  }
}
