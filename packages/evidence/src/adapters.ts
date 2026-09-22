/**
 * Offline adapters (tasks/P5.md): read the SQLite index shards (read-only) and
 * the bundle-store files directly — no network, no HCS, no payment.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
  const root = resolve(storeDir);
  return {
    get(bundlePath: string): VerifiableBundle | undefined {
      // Contain reads within storeDir — a hostile bundlePath ("../…") must not
      // escape the store (path-traversal / arbitrary file read).
      const full = resolve(root, bundlePath);
      const rel = relative(root, full);
      if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
        return undefined;
      }
      try {
        return JSON.parse(readFileSync(full, "utf8")) as VerifiableBundle;
      } catch {
        return undefined;
      }
    },
  };
}
