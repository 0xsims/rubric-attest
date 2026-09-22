/**
 * The gate()-fronted /v1/x402/decision-verify route (tasks/P4.md).
 *
 * Query:
 *   ?decisionId=... | ?decisionHash=...   -> single-record verification
 *   ?agentId=...    (or ?mode=chain)      -> chain-check continuity report
 */
import { assembleVerification } from "./verify.js";
import { chainCheck } from "./chain.js";
import { gate, type PaymentVerifier } from "./gate.js";
import { json, type Handler, type VerifyRequest, type VerifyResponse } from "./http.js";
import type { BazaarConfig } from "./bazaar.js";
import type { IndexPort, SignatureVerifier, StorePort } from "./ports.js";

export const DECISION_VERIFY_PATH = "/v1/x402/decision-verify";

export interface VerifyRouteDeps {
  index: IndexPort;
  store: StorePort;
  verifySignature: SignatureVerifier;
  bazaar: BazaarConfig;
  verifyPayment: PaymentVerifier;
}

/** The paid handler — this is where index/store work happens. */
function decisionVerify(req: VerifyRequest, deps: VerifyRouteDeps): VerifyResponse {
  const { decisionId, decisionHash, agentId, mode } = req.query;

  if (mode === "chain" || agentId) {
    if (!agentId) return json(400, { error: "agentId is required for chain-check" });
    return json(200, chainCheck(agentId, deps.index.agentChain(agentId)));
  }

  const row = decisionId
    ? deps.index.byDecisionId(decisionId)
    : decisionHash
      ? deps.index.byDecisionHash(decisionHash)
      : undefined;

  if (!decisionId && !decisionHash) {
    return json(400, { error: "decisionId or decisionHash is required" });
  }
  if (!row) return json(404, { error: "decision not found" });

  const bundle = deps.store.get(row.bundlePath);
  if (!bundle) return json(502, { error: "bundle missing from store", bundlePath: row.bundlePath });

  return json(200, assembleVerification(bundle, deps.verifySignature));
}

/** Build the gate()-fronted route handler. */
export function createDecisionVerifyRoute(deps: VerifyRouteDeps): Handler {
  const handler: Handler = (req) => decisionVerify(req, deps);
  return gate(handler, { bazaar: deps.bazaar, verifyPayment: deps.verifyPayment });
}
