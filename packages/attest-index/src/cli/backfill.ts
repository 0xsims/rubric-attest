#!/usr/bin/env -S node --import tsx
/**
 * CLI: rebuild the attestation index from a bundle store.
 *   rubric-index-backfill <bundle-store-dir> <index-dir>
 */
import { backfill } from "../backfill.js";

function main(argv: string[]): void {
  const [storeDir, indexDir] = argv;
  if (!storeDir || !indexDir) {
    process.stderr.write("usage: rubric-index-backfill <bundle-store-dir> <index-dir>\n");
    process.exit(2);
  }
  const result = backfill(storeDir, indexDir);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main(process.argv.slice(2));
