import { describe, it, expect } from "vitest";
import { sha3_256 } from "@rubric/attest-decision";
import { assembleVerification } from "../src/index.js";
import { buildFixture, invalidSignature, makeDars, validSignature } from "./helpers/fixtures.js";

describe("assembleVerification", () => {
  it("verifies an intact record: no drift, verified, signature ok", () => {
    const fx = buildFixture(makeDars("agent://a", [{ x: 1 }, { x: 2 }]));
    const r = assembleVerification(fx.bundles[0]!, validSignature);
    expect(r.drift).toBe(false);
    expect(r.verified).toBe(true);
    expect(r.signature.verified).toBe(true);
    expect(r.anchorRef.root).toBe(fx.root);
    expect(r.merkleProof.root).toBe(fx.root);
    expect(r.decisionId).toBe(fx.bundles[0]!.dar.decisionId);
  });

  it("flags drift when the decision payload is tampered", () => {
    const fx = buildFixture(makeDars("agent://a", [{ x: 1 }]));
    const b = fx.bundles[0]!;
    const tampered = { ...b, dar: { ...b.dar, decision: { x: 999 } } };
    const r = assembleVerification(tampered, validSignature);
    expect(r.drift).toBe(true);
    expect(r.verified).toBe(false);
  });

  it("flags drift when the anchored root diverges from the proof root", () => {
    const fx = buildFixture(makeDars("agent://a", [{ x: 1 }]));
    const b = fx.bundles[0]!;
    const tampered = { ...b, anchorRef: { ...b.anchorRef, root: sha3_256("some-other-root") } };
    const r = assembleVerification(tampered, validSignature);
    expect(r.drift).toBe(true);
    expect(r.verified).toBe(false);
  });

  it("reports a signature failure without asserting drift", () => {
    const fx = buildFixture(makeDars("agent://a", [{ x: 1 }]));
    const r = assembleVerification(fx.bundles[0]!, invalidSignature);
    expect(r.drift).toBe(false); // the record still matches its commitment
    expect(r.signature.verified).toBe(false);
    expect(r.verified).toBe(false); // but overall verification fails
  });
});
