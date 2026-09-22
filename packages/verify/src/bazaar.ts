/**
 * x402 discovery + settlement (tasks/P4.md). An unpaid request is answered with
 * `svcSend402`: HTTP 402 carrying a "bazaar blob" — the discoverable payment
 * requirements — computed with zero downstream (index/store) work. A settled
 * (paid) response carries `extensions.bazaar`.
 */
import { json, type VerifyResponse } from "./http.js";

export interface BazaarConfig {
  resource: string; // e.g. "/v1/x402/decision-verify"
  network: string; // e.g. "hedera-testnet"
  asset: string; // token/asset identifier
  maxAmountRequired: string; // price, atomic units, as a string
  payTo: string; // recipient address
  description?: string;
  discoveryUrl?: string; // bazaar listing URL
  category?: string;
}

export interface X402Accept {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  payTo: string;
  asset: string;
  mimeType: "application/json";
}

export interface BazaarBlob {
  x402Version: 1;
  accepts: X402Accept[];
  bazaar: { discoverable: true; resource: string; category: string; url?: string };
}

/** The discoverable 402 challenge body. */
export function buildBazaarBlob(cfg: BazaarConfig): BazaarBlob {
  const accept: X402Accept = {
    scheme: "exact",
    network: cfg.network,
    maxAmountRequired: cfg.maxAmountRequired,
    resource: cfg.resource,
    description: cfg.description ?? "Rubric decision-verify",
    payTo: cfg.payTo,
    asset: cfg.asset,
    mimeType: "application/json",
  };
  const bazaar: BazaarBlob["bazaar"] = {
    discoverable: true,
    resource: cfg.resource,
    category: cfg.category ?? "attestation.verify",
  };
  if (cfg.discoveryUrl !== undefined) bazaar.url = cfg.discoveryUrl;
  return { x402Version: 1, accepts: [accept], bazaar };
}

/** Instant 402 (no downstream work): the discovery response. */
export function svcSend402(cfg: BazaarConfig): VerifyResponse {
  return json(402, buildBazaarBlob(cfg), { "www-authenticate": `x402 resource="${cfg.resource}"` });
}

export interface SettlementBlob {
  settled: true;
  resource: string;
  network: string;
  asset: string;
  amount: string;
  payer?: string;
  settlementId?: string;
}

/** The `extensions.bazaar` payload attached to a settled response. */
export function settlementBlob(
  cfg: BazaarConfig,
  payment: { payer?: string; settlementId?: string },
): SettlementBlob {
  const blob: SettlementBlob = {
    settled: true,
    resource: cfg.resource,
    network: cfg.network,
    asset: cfg.asset,
    amount: cfg.maxAmountRequired,
  };
  if (payment.payer !== undefined) blob.payer = payment.payer;
  if (payment.settlementId !== undefined) blob.settlementId = payment.settlementId;
  return blob;
}
