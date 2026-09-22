import { describe, it, expect } from "vitest";
import { chainCheck } from "../src/index.js";
import type { IndexRow } from "../src/index.js";

function row(decisionId: string, prev: string | null): IndexRow {
  return {
    attestationId: `att-${decisionId}`,
    decisionId,
    agentId: "A",
    schemaHash: "sha3-256:s",
    decisionHash: "sha3-256:d",
    prev,
    ts: "2025-09-22T00:00:00.000Z",
    leafType: "decision",
    bundlePath: `b/${decisionId}.json`,
  };
}

describe("chainCheck continuity report", () => {
  it("reports a single unbroken linear chain", () => {
    const r = chainCheck("A", [row("D1", null), row("D2", "D1"), row("D3", "D2")]);
    expect(r.count).toBe(3);
    expect(r.genesis).toEqual(["D1"]);
    expect(r.heads).toEqual(["D3"]);
    expect(r.branches).toEqual([]);
    expect(r.gaps).toEqual([]);
    expect(r.linear).toBe(true);
    expect(r.tampering).toBe(false);
  });

  it("reports a fork as a branch — never tampering", () => {
    // D2 and D2b both extend D1.
    const r = chainCheck("A", [row("D1", null), row("D2", "D1"), row("D2b", "D1")]);
    expect(r.branches).toEqual([{ parent: "D1", children: ["D2", "D2b"] }]);
    expect(r.heads).toEqual(["D2", "D2b"]);
    expect(r.genesis).toEqual(["D1"]);
    expect(r.linear).toBe(false);
    expect(r.tampering).toBe(false); // forks are branches, not tampering
  });

  it("reports a gap when a prev points at an absent decision", () => {
    const r = chainCheck("A", [row("D2", "D1"), row("D3", "D2")]); // D1 missing
    expect(r.gaps).toEqual([{ decisionId: "D2", missingPrev: "D1" }]);
    expect(r.genesis).toEqual([]);
    expect(r.heads).toEqual(["D3"]);
    expect(r.linear).toBe(false);
    expect(r.tampering).toBe(false);
  });

  it("handles an empty chain", () => {
    const r = chainCheck("A", []);
    expect(r.count).toBe(0);
    expect(r.linear).toBe(false);
    expect(r.tampering).toBe(false);
  });
});
