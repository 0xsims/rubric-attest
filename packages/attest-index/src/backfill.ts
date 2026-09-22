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
import { rowFromBundle, type AttestationBundle, type IndexRow } from "./schema.js";

export interface BackfillResult {
  bundleFiles: number;
  rowsWritten: number;
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
  if (typeof b.attestationId !== "string") return false;
  const d = b.dar as Record<string, unknown> | undefined;
  return (
    !!d &&
    typeof d.decisionId === "string" &&
    typeof d.agentId === "string" &&
    typeof d.ts === "string"
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
      rows.push(rowFromBundle(parsed, relative(storeDir, file)));
    }
    const rowsWritten = index.writeBatch(rows);
    return {
      bundleFiles: files.length,
      rowsWritten,
      skipped,
      days: index.shardDays(),
    };
  } finally {
    index.close();
  }
}
