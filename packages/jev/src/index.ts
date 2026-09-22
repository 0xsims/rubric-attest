/**
 * @rubric/jev — Jev decision-shape adapter (tasks/P3.md).
 *
 * All knowledge of Jev's documented decision shape is confined to ./mapping.ts;
 * `toDecision()` there produces DAR builder inputs for @rubric/attest-decision.
 */
export { toDecision, type JevDecision } from "./mapping.js";
export { StubJevClient, type StubJevOptions } from "./client.js";

export const JEV_ADAPTER_VERSION = "0.1.0" as const;
