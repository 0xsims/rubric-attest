#!/usr/bin/env node
/**
 * CLI: ingest attestation-index.jsonl (anchor links) and the DAR bundles into the index.
 *   rubric-index-ingest <attestation-index.jsonl> <bundle-store-dir> <index-dir>
 * Reads the jsonl only; never writes it. No network access.
 */
import { ingest } from "../ingest.js";

function main(argv: string[]): void {
  const [jsonl, storeDir, indexDir] = argv;
  if (!jsonl || !storeDir || !indexDir || argv.length > 3) {
    process.stderr.write("usage: rubric-index-ingest <attestation-index.jsonl> <bundle-store-dir> <index-dir>\n");
    process.exit(2);
  }
  const result = ingest(jsonl, storeDir, indexDir);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main(process.argv.slice(2));
