import { describe, it, expect } from "vitest";
import {
  createDecisionVerifyRoute,
  DECISION_VERIFY_PATH,
  X402_PAYMENT_HEADER,
  type BazaarBlob,
  type BazaarConfig,
  type ContinuityReport,
  type IndexPort,
  type PaymentResult,
  type StorePort,
  type VerificationResult,
  type VerifyRequest,
} from "../src/index.js";
import { buildFixture, makeDars, validSignature } from "./helpers/fixtures.js";

const bazaar: BazaarConfig = {
  resource: DECISION_VERIFY_PATH,
  network: "hedera-testnet",
  asset: "HBAR",
  maxAmountRequired: "1000",
  payTo: "0.0.99",
};
const paid = (): PaymentResult => ({ paid: true, payer: "0.0.1", settlementId: "s1" });
const unpaid = (): PaymentResult => ({ paid: false });

/** Wrap index+store to count accesses (to assert the 402 path touches neither). */
function counting(index: IndexPort, store: StorePort) {
  const calls = { index: 0, store: 0 };
  const wIndex: IndexPort = {
    byDecisionId: (id) => (calls.index++, index.byDecisionId(id)),
    byDecisionHash: (h) => (calls.index++, index.byDecisionHash(h)),
    agentChain: (a) => (calls.index++, index.agentChain(a)),
  };
  const wStore: StorePort = { get: (p) => (calls.store++, store.get(p)) };
  return { wIndex, wStore, calls };
}

function setup(verifyPayment = paid) {
  const dars = makeDars("agent://pricing", [{ a: 1 }, { a: 2 }]);
  const fx = buildFixture(dars);
  const { wIndex, wStore, calls } = counting(fx.index, fx.store);
  const route = createDecisionVerifyRoute({
    index: wIndex,
    store: wStore,
    verifySignature: validSignature,
    bazaar,
    verifyPayment,
  });
  return { route, fx, dars, calls };
}

const req = (query: Record<string, string>, headers: Record<string, string> = {}): VerifyRequest => ({
  method: "GET",
  path: DECISION_VERIFY_PATH,
  query,
  headers,
});

const withPayment = (query: Record<string, string>) => req(query, { [X402_PAYMENT_HEADER]: "paid" });

describe("decision-verify route (mocked index + store)", () => {
  it("unpaid GET -> 402 discovery, index and store untouched", async () => {
    const { route, calls } = setup(unpaid);
    const res = await route(req({ decisionId: "01J8Z9Q0000000000000000001" }));
    expect(res.status).toBe(402);
    expect((res.body as BazaarBlob).bazaar.discoverable).toBe(true);
    expect(calls.index).toBe(0);
    expect(calls.store).toBe(0);
  });

  it("paid byDecisionId -> 200 verification carrying extensions.bazaar", async () => {
    const { route, dars } = setup();
    const res = await route(withPayment({ decisionId: dars[0]!.decisionId }));
    expect(res.status).toBe(200);
    const body = res.body as VerificationResult & { extensions: { bazaar: { settled: boolean } } };
    expect(body.decisionId).toBe(dars[0]!.decisionId);
    expect(body.status).toBe("ok");
    expect(body.consistencyVerified).toBe(true);
    expect(body.drift).toBe(false);
    expect(body.merkleProof.steps.length).toBeGreaterThan(0);
    expect(body.anchorRef.network).toBe("hedera-testnet");
    expect(body.extensions.bazaar.settled).toBe(true);
  });

  it("paid byDecisionHash -> 200", async () => {
    const { route, dars } = setup();
    const res = await route(withPayment({ decisionHash: dars[1]!.decisionHash }));
    expect(res.status).toBe(200);
    expect((res.body as VerificationResult).decisionId).toBe(dars[1]!.decisionId);
  });

  it("paid agentId chain-check -> 200 continuity report", async () => {
    const { route, dars } = setup();
    const res = await route(withPayment({ agentId: "agent://pricing" }));
    expect(res.status).toBe(200);
    const body = res.body as ContinuityReport & { extensions: unknown };
    expect(body.agentId).toBe("agent://pricing");
    expect(body.count).toBe(2);
    expect(body.linear).toBe(true);
    expect(body.heads).toEqual([dars[1]!.decisionId]);
    expect(body.tampering).toBe(false);
  });

  it("paid unknown decisionId -> 404", async () => {
    const { route } = setup();
    const res = await route(withPayment({ decisionId: "does-not-exist" }));
    expect(res.status).toBe(404);
  });

  it("paid with no selector -> 400", async () => {
    const { route } = setup();
    const res = await route(withPayment({}));
    expect(res.status).toBe(400);
  });

  it("paid but bundle missing from store -> 502", async () => {
    const dars = makeDars("agent://pricing", [{ a: 1 }]);
    const fx = buildFixture(dars);
    const emptyStore: StorePort = { get: () => undefined };
    const route = createDecisionVerifyRoute({
      index: fx.index,
      store: emptyStore,
      verifySignature: validSignature,
      bazaar,
      verifyPayment: paid,
    });
    const res = await route(withPayment({ decisionId: dars[0]!.decisionId }));
    expect(res.status).toBe(502);
  });
});
