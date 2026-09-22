import { describe, it, expect } from "vitest";
import { sha3_256 } from "@rubric-protocol/attest-decision";
import { assembleVerification } from "../src/index.js";
import { buildFixture, invalidSignature, makeDars, validSignature } from "./helpers/fixtures.js";

describe("assembleVerification", () => {
  it("verifies an intact record: ok, no drift, consistent, signature ok", () => {
    const fx = buildFixture(makeDars("agent://a", [{ x: 1 }, { x: 2 }]));
    const r = assembleVerification(fx.bundles[0]!, validSignature);
    expect(r.status).toBe("ok");
    expect(r.drift).toBe(false);
    expect(r.consistencyVerified).toBe(true);
    expect(r.signature.verified).toBe(true);
    expect(r.anchorRef.root).toBe(fx.root);
    expect(r.merkleProof.root).toBe(fx.root);
    expect(r.decisionId).toBe(fx.bundles[0]!.dar.decisionId);
  });

  it("flags drift when a content commitment is tampered (decisionHash no longer matches)", () => {
    const fx = buildFixture(makeDars("agent://a", [{ x: 1 }]));
    const b = fx.bundles[0]!;
    // Swap inputHash without recomputing decisionHash -> the tri-hash breaks.
    const tampered = { ...b, dar: { ...b.dar, inputHash: sha3_256("tampered-input") } };
    const r = assembleVerification(tampered, validSignature);
    expect(r.drift).toBe(true);
    expect(r.consistencyVerified).toBe(false);
  });

  it("flags drift when the anchored root diverges from the proof root", () => {
    const fx = buildFixture(makeDars("agent://a", [{ x: 1 }]));
    const b = fx.bundles[0]!;
    const tampered = { ...b, anchorRef: { ...b.anchorRef, root: sha3_256("some-other-root") } };
    const r = assembleVerification(tampered, validSignature);
    expect(r.drift).toBe(true);
    expect(r.consistencyVerified).toBe(false);
  });

  it("reports a signature failure without asserting drift", () => {
    const fx = buildFixture(makeDars("agent://a", [{ x: 1 }]));
    const r = assembleVerification(fx.bundles[0]!, invalidSignature);
    expect(r.drift).toBe(false); // the record still matches its commitment
    expect(r.signature.verified).toBe(false);
    expect(r.consistencyVerified).toBe(false); // but overall consistency fails
  });

  it("rejects an unknown DAR major (does not strip-and-rehash)", () => {
    const fx = buildFixture(makeDars("agent://a", [{ x: 1 }]));
    const b = fx.bundles[0]!;
    const future = { ...b, dar: { ...b.dar, v: "DAR/9.0" as typeof b.dar.v } };
    const r = assembleVerification(future, validSignature);
    expect(r.status).toBe("rejected");
    expect(r.consistencyVerified).toBe(false);
  });

  it("reports needs-upgrade for a newer minor within a known major", () => {
    const fx = buildFixture(makeDars("agent://a", [{ x: 1 }]));
    const b = fx.bundles[0]!;
    const newer = { ...b, dar: { ...b.dar, v: "DAR/0.2" as typeof b.dar.v } };
    const r = assembleVerification(newer, validSignature);
    expect(r.status).toBe("needs-upgrade");
    expect(r.consistencyVerified).toBe(false);
  });

  it("rejects an unknown leafType", () => {
    const fx = buildFixture(makeDars("agent://a", [{ x: 1 }]));
    const b = fx.bundles[0]!;
    const bad = { ...b, dar: { ...b.dar, leafType: "bogus" as typeof b.dar.leafType } };
    const r = assembleVerification(bad, validSignature);
    expect(r.status).toBe("rejected");
    expect(r.consistencyVerified).toBe(false);
  });
});
