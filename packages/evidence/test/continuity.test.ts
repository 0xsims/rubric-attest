import { describe, it, expect, afterEach } from "vitest";
import { buildSchemaChangeLog, exportEvidence, openIndexReader, openStoreReader } from "../src/index.js";
import type { IndexRow } from "../src/index.js";
import { buildStoreFixture, makeDar, ID, TS, type StoreFixture } from "./helpers/store-fixture.js";

const AGENT = "agent://a";

let fx: StoreFixture | undefined;
afterEach(() => fx?.cleanup());

function exportAll(f: StoreFixture) {
  const index = openIndexReader(f.indexDir);
  try {
    return exportEvidence(index, openStoreReader(f.storeDir), {
      agent: AGENT,
      from: "2025-09-22T00:00:00.000Z",
      to: "2025-09-22T23:59:59.999Z",
      generatedAt: "2025-09-22T12:00:00.000Z",
    });
  } finally {
    index.close?.();
  }
}

describe("continuity report in the evidence bundle", () => {
  it("renders a fork as a branch — never tampering", () => {
    fx = buildStoreFixture([
      makeDar({ decisionId: ID(1), prev: null, decision: { n: 1 }, ts: TS(1), agentId: AGENT }),
      makeDar({ decisionId: ID(2), prev: ID(1), decision: { n: 2 }, ts: TS(2), agentId: AGENT }),
      makeDar({ decisionId: ID(3), prev: ID(1), decision: { n: 3 }, ts: TS(3), agentId: AGENT }), // fork off D1
    ]);
    const { bundle } = exportAll(fx);
    expect(bundle.decisionCount).toBe(3);
    expect(bundle.continuity.branches).toEqual([{ parent: ID(1), children: [ID(2), ID(3)] }]);
    expect(bundle.continuity.heads).toEqual([ID(2), ID(3)]);
    expect(bundle.continuity.linear).toBe(false);
    expect(bundle.continuity.tampering).toBe(false);
  });

  it("renders a gap when a decision's prev is absent from the export", () => {
    fx = buildStoreFixture([
      // D1 is never stored/indexed; D2 references it -> gap.
      makeDar({ decisionId: ID(2), prev: ID(1), decision: { n: 2 }, ts: TS(2), agentId: AGENT }),
      makeDar({ decisionId: ID(3), prev: ID(2), decision: { n: 3 }, ts: TS(3), agentId: AGENT }),
    ]);
    const { bundle } = exportAll(fx);
    expect(bundle.continuity.gaps).toEqual([{ decisionId: ID(2), missingPrev: ID(1) }]);
    expect(bundle.continuity.linear).toBe(false);
    expect(bundle.continuity.tampering).toBe(false);
  });
});

describe("schema-change log", () => {
  const row = (decisionId: string, schemaHash: string, ts: string): IndexRow => ({
    attestationId: `att-${decisionId}`,
    decisionId,
    agentId: AGENT,
    schemaHash,
    decisionHash: "sha3-256:d",
    prev: null,
    ts,
    leafType: "decision",
    bundlePath: `b/${decisionId}.json`,
  });

  it("logs consecutive-run epochs, including a change back to a prior schema", () => {
    const rows = [
      row(ID(1), "sha3-256:a", TS(1)),
      row(ID(2), "sha3-256:a", TS(2)),
      row(ID(3), "sha3-256:b", TS(3)),
      row(ID(4), "sha3-256:a", TS(4)),
    ];
    expect(buildSchemaChangeLog(rows)).toEqual([
      { schemaHash: "sha3-256:a", fromDecisionId: ID(1), fromTs: TS(1), count: 2 },
      { schemaHash: "sha3-256:b", fromDecisionId: ID(3), fromTs: TS(3), count: 1 },
      { schemaHash: "sha3-256:a", fromDecisionId: ID(4), fromTs: TS(4), count: 1 },
    ]);
  });
});
