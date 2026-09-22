import { describe, it, expect } from "vitest";
import {
  gate,
  json,
  X402_PAYMENT_HEADER,
  type BazaarBlob,
  type BazaarConfig,
  type Handler,
  type SettlementBlob,
  type VerifyRequest,
} from "../src/index.js";

const bazaar: BazaarConfig = {
  resource: "/v1/x402/decision-verify",
  network: "hedera-testnet",
  asset: "HBAR",
  maxAmountRequired: "1000",
  payTo: "0.0.99",
};

const getReq = (headers: Record<string, string | undefined> = {}): VerifyRequest => ({
  method: "GET",
  path: bazaar.resource,
  query: {},
  headers,
});

describe("x402 gate", () => {
  it("answers unpaid requests with a 402 bazaar blob and never runs the handler", async () => {
    let ran = false;
    const handler: Handler = () => {
      ran = true;
      return json(200, { ok: true });
    };
    const gated = gate(handler, { bazaar, verifyPayment: () => ({ paid: false }) });

    const res = await gated(getReq());
    expect(res.status).toBe(402);
    expect(ran).toBe(false); // no downstream (DB) work on the discovery path
    const blob = res.body as BazaarBlob;
    expect(blob.x402Version).toBe(1);
    expect(blob.accepts[0]!.resource).toBe(bazaar.resource);
    expect(blob.accepts[0]!.maxAmountRequired).toBe("1000");
    expect(blob.bazaar.discoverable).toBe(true);
  });

  it("answers the unpaid 402 in well under 200 ms with no downstream work", async () => {
    const gated = gate(
      () => {
        throw new Error("handler must not run on the discovery path");
      },
      { bazaar, verifyPayment: () => ({ paid: false }) },
    );
    const t0 = process.hrtime.bigint();
    const res = await gated(getReq());
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(res.status).toBe(402);
    expect(ms).toBeLessThan(200);
  });

  it("runs the handler on the paid path and attaches extensions.bazaar on settle", async () => {
    const handler: Handler = () => json(200, { decisionId: "X", verified: true });
    const gated = gate(handler, {
      bazaar,
      verifyPayment: (hdr) => ({ paid: hdr === "paid-token", payer: "0.0.55", settlementId: "s1" }),
    });

    const res = await gated(getReq({ [X402_PAYMENT_HEADER]: "paid-token" }));
    expect(res.status).toBe(200);
    const body = res.body as { decisionId: string; extensions: { bazaar: SettlementBlob } };
    expect(body.decisionId).toBe("X");
    expect(body.extensions.bazaar.settled).toBe(true);
    expect(body.extensions.bazaar.payer).toBe("0.0.55");
    expect(body.extensions.bazaar.amount).toBe("1000");
    expect(res.headers["x-payment-response"]).toBeTruthy();
  });

  it("does not attach extensions to non-2xx paid responses", async () => {
    const gated = gate(() => json(404, { error: "nope" }), {
      bazaar,
      verifyPayment: () => ({ paid: true }),
    });
    const res = await gated(getReq({ [X402_PAYMENT_HEADER]: "x" }));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "nope" });
  });
});
