/**
 * Offline adapters (tasks/P5.md): read the SQLite index shards (read-only) and
 * the bundle-store files directly — no network, no HCS, no payment.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Index } from "@rubric/attest-index";
import type { EvidenceIndex, StorePort, VerifiableBundle } from "./ports.js";

/** Index reader backed by the read-only SQLite day-shards under `indexDir`. */
export function openIndexReader(indexDir: string): EvidenceIndex {
  const index = new Index(indexDir, { readonly: true });
  return {
    byAgentRange: (agentId, from, to) => index.byAgentRange(agentId, from, to),
    close: () => index.close(),
  };
}

/** Store reader over `storeDir`; a row's bundlePath is relative to it. */
export function openStoreReader(storeDir: string): StorePort {
  return {
    get(bundlePath: string): VerifiableBundle | undefined {
      try {
        return JSON.parse(readFileSync(join(storeDir, bundlePath), "utf8")) as VerifiableBundle;
      } catch {
        return undefined;
      }
    },
  };
}
