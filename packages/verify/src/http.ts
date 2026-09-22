/**
 * Framework-agnostic request/response shapes for the route, plus a thin Node
 * `http` adapter. The route is a pure `Handler` so tests drive it directly; the
 * adapter is for running it as a real server.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface VerifyRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
}

export interface VerifyResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type Handler = (req: VerifyRequest) => VerifyResponse | Promise<VerifyResponse>;

/** Build a JSON response. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): VerifyResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body };
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Adapt a Handler to a Node `http` request listener. */
export function toNodeListener(handler: Handler) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const query: Record<string, string | undefined> = {};
    for (const [k, val] of url.searchParams) query[k] = val;
    const headers: Record<string, string | undefined> = {};
    for (const [k, val] of Object.entries(req.headers)) headers[k.toLowerCase()] = firstHeader(val);

    const request: VerifyRequest = { method: req.method ?? "GET", path: url.pathname, query, headers };

    Promise.resolve(handler(request))
      .then((r) => {
        res.writeHead(r.status, r.headers);
        res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
      })
      .catch(() => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      });
  };
}
