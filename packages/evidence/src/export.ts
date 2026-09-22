/**
 * Export orchestration: assemble the evidence bundle and render its plain-text
 * summary together (tasks/P5.md).
 */
import { assembleEvidence, type AssembleOptions } from "./bundle.js";
import { renderSummary } from "./summary.js";
import type { EvidenceBundle, EvidenceIndex, StorePort } from "./ports.js";

export interface ExportResult {
  bundle: EvidenceBundle;
  summary: string;
}

export function exportEvidence(
  index: EvidenceIndex,
  store: StorePort,
  opts: AssembleOptions,
): ExportResult {
  const bundle = assembleEvidence(index, store, opts);
  return { bundle, summary: renderSummary(bundle) };
}
