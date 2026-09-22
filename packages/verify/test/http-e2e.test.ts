import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DarCore } from "@rubric/attest-decision";
import {
  createDecisionVerifyRoute,
  toNodeListener,
  DECISION_VERIFY_PATH,
  X402_PAYMENT_HEADER,
  type BazaarConfig,
} from "../src/index.js";
import { buildFixture, makeDars, validSignature } from "./helpers/fixtures.js";

const bazaar: BazaarConfig = {
  resource: DECISION_VERIFY_PATH,
  network: "hedera-testnet",
  asset: "HBAR",
  maxAmountRequired: "1000",
  payTo: "0.0.99",
};

let server: Server;
let base: string;
let dars: DarCore[];

beforeAll(async () => {
  dars = makeDars("agent://http", [{ a: 1 }]);
  const fx = buildFixture(dars);
  const route = createDecisionVerifyRoute({
    index: fx.index,
    store: fx.store,
    verifySignature: validSignature,
    bazaar,
    verifyPayment: (h) => ({ paid: h === "paid", payer: "0.0.1", settlementId: "s1" }),
  });
  server = createServer(toNodeListener(route));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("decision-verify over real HTTP", () => {
  it("answers an unpaid GET with 402 + bazaar blob in <200 ms", async () => {
    const t0 = process.hrtime.bigint();
    const res = await fetch(`${base}${DECISION_VERIFY_PATH}?decisionId=${dars[0]!.decisionId}`);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; accepts: { resource: string }[] };
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0]!.resource).toBe(DECISION_VERIFY_PATH);
    expect(ms).toBeLessThan(200);
  });

  it("answers a paid GET with 200 + extensions.bazaar", async () => {
    const res = await fetch(`${base}${DECISION_VERIFY_PATH}?decisionId=${dars[0]!.decisionId}`, {
      headers: { [X402_PAYMENT_HEADER]: "paid" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-payment-response")).toBeTruthy();
    const body = (await res.json()) as {
      verified: boolean;
      drift: boolean;
      extensions: { bazaar: { settled: boolean } };
    };
    expect(body.verified).toBe(true);
    expect(body.drift).toBe(false);
    expect(body.extensions.bazaar.settled).toBe(true);
  });
});
