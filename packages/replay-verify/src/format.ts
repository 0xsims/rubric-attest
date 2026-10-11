import type { Report } from "./verify.js";

/** Human-readable report. Always lists all five steps and the topic. */
export function formatReport(r: Report): string {
  const lines: string[] = [];
  lines.push(`tenprint-verify: ${r.verdict} (exit ${r.exitCode}) — ${r.recordKind} record`);
  lines.push(`  ${r.verdictDetail}`);
  lines.push("");
  for (const s of r.steps) {
    lines.push(`  [${s.status.padEnd(11)}] ${s.name.padEnd(9)} ${s.reason ? `${s.reason}: ` : ""}${s.detail}`);
  }
  lines.push("");
  const a = r.anchor;
  lines.push(`  topic ${a.topic} via ${a.mirror}`);
  lines.push(`  anchorId ${a.anchorId ?? "-"}`);
  if (a.sequenceNumber !== null) {
    lines.push(`  anchor seq ${a.sequenceNumber}, consensus ${a.consensusTimestamp}, payer ${a.payerAccountId}, aggregateRoot ${a.aggregateRoot}`);
  }
  if (a.searched) {
    const ranges = a.searched.sequenceRanges.map(([lo, hi]) => `${lo}-${hi}`).join(", ") || "none";
    lines.push(`  searched: sequences [${ranges}], time ${a.searched.timeWindow?.from} .. ${a.searched.timeWindow?.to}`);
  }
  const p = r.anchorPayers;
  lines.push(`  anchor payers (${p.source}${p.attested === false ? ", UNATTESTED" : ""}): ${p.accounts.join(", ") || "(none)"}`);
  for (const w of r.warnings) lines.push(`  warning: ${w}`);
  return lines.join("\n") + "\n";
}
