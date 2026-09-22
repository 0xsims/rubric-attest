/**
 * Plain-text summary of an evidence bundle (tasks/P5.md). Deterministic — every
 * line is derived from bundle fields, so it is stable for golden comparison.
 */
import type { EvidenceBundle } from "./ports.js";

export function renderSummary(bundle: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push("Rubric Decision Evidence");
  lines.push(`  version:   ${bundle.version}`);
  lines.push(`  agent:     ${bundle.agent}`);
  lines.push(`  range:     ${bundle.range.from} .. ${bundle.range.to}`);
  lines.push(`  generated: ${bundle.generatedAt}`);
  lines.push(`  decisions: ${bundle.decisionCount}`);

  const c = bundle.continuity;
  const shape = c.linear
    ? "linear"
    : [
        c.branches.length ? `${c.branches.length} fork(s)` : "",
        c.gaps.length ? `${c.gaps.length} gap(s)` : "",
      ]
        .filter(Boolean)
        .join(", ") || "non-linear";
  lines.push("");
  lines.push(`Continuity: ${shape} (tampering: ${c.tampering})`);
  lines.push(`  genesis: ${c.genesis.join(", ") || "(none)"}`);
  lines.push(`  heads:   ${c.heads.join(", ") || "(none)"}`);
  for (const b of c.branches) {
    lines.push(`  fork at ${b.parent} -> ${b.children.join(", ")}`);
  }
  for (const g of c.gaps) {
    lines.push(`  gap: ${g.decisionId} references missing ${g.missingPrev}`);
  }

  lines.push("");
  lines.push(`Schema epochs: ${bundle.schemaChangeLog.length}`);
  for (const e of bundle.schemaChangeLog) {
    lines.push(`  ${e.schemaHash} from ${e.fromDecisionId} @ ${e.fromTs} (${e.count} decision(s))`);
  }

  const anchors = new Set(bundle.decisions.map((d) => `${d.anchorRef.network}:${d.anchorRef.topicId}`));
  lines.push("");
  lines.push(`Anchors: ${[...anchors].sort().join(", ") || "(none)"}`);

  return lines.join("\n") + "\n";
}
