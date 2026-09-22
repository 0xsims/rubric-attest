/**
 * x402 payment gate (tasks/P4.md). Fronts a handler: an unpaid request is
 * answered instantly with `svcSend402` (the bazaar discovery blob) — the wrapped
 * handler, which does the index/store work, is NEVER invoked until payment is
 * present, so discovery does zero DB work. A settled response carries
 * `extensions.bazaar` (and an `x-payment-response` header).
 */
import { svcSend402, settlementBlob, type BazaarConfig } from "./bazaar.js";
import type { Handler, VerifyRequest, VerifyResponse } from "./http.js";

export const X402_PAYMENT_HEADER = "x-payment";

export interface PaymentResult {
  paid: boolean;
  payer?: string;
  settlementId?: string;
}

/** Verifies a payment header. Injected + mockable; MUST NOT do DB work. */
export type PaymentVerifier = (
  paymentHeader: string | undefined,
  req: VerifyRequest,
) => PaymentResult;

export interface GateOptions {
  bazaar: BazaarConfig;
  verifyPayment: PaymentVerifier;
  paymentHeader?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function gate(handler: Handler, opts: GateOptions): Handler {
  const headerName = (opts.paymentHeader ?? X402_PAYMENT_HEADER).toLowerCase();
  return async (req: VerifyRequest): Promise<VerifyResponse> => {
    const payment = opts.verifyPayment(req.headers[headerName], req);
    if (!payment.paid) {
      // Discovery: instant 402 with the bazaar blob, before any downstream work.
      return svcSend402(opts.bazaar);
    }

    const res = await handler(req);

    // Settle path: attach extensions.bazaar to a successful JSON body.
    if (res.status >= 200 && res.status < 300 && isObject(res.body)) {
      const settle = settlementBlob(opts.bazaar, payment);
      const existingExt = isObject(res.body.extensions) ? res.body.extensions : {};
      res.body = { ...res.body, extensions: { ...existingExt, bazaar: settle } };
      res.headers["x-payment-response"] = Buffer.from(JSON.stringify(settle), "utf8").toString("base64");
    }
    return res;
  };
}
