/**
 * The one network path (spec §4.2). Every request goes through the guarded
 * fetch, which allows exactly:
 *   1. GET https://tenprint.ai/.well-known/rubric-keys.json, then on failure
 *      GET https://rubric-protocol.com/.well-known/rubric-keys.json  (not with --keys)
 *   2. GET <mirror>/api/v1/topics/<topic>/messages?<query>          (incl. links.next)
 * and throws NetworkGuardError for anything else: /v1/*, the keys file's
 * attestation.verify URL, /api/v1/topics/<topic> (topic info), /messages/<seq>,
 * mainnet.mirrornode.hedera.com, any other host or path.
 */
import {
  FORBIDDEN_MIRROR_HOSTS,
  KEYS_URLS,
  MAX_RETRIES,
  OPERATOR_DOMAINS,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_MS,
} from "./constants.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class NetworkGuardError extends Error {
  constructor(public readonly url: string, why: string) {
    super(`network guard: refused ${url}: ${why}`);
    this.name = "NetworkGuardError";
  }
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function isOperatorHost(host: string): boolean {
  const h = host.replace(/\.+$/, ""); // "tenprint.ai." is the same host
  return OPERATOR_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Validate a --mirror base URL; returns its origin. Throws UsageError. */
export function validateMirror(base: string): string {
  let u: URL;
  try { u = new URL(base); } catch { throw new UsageError(`--mirror is not a URL: ${base}`); }
  if (u.protocol !== "https:") throw new UsageError("--mirror must be https");
  if (u.username || u.password) throw new UsageError("--mirror must not carry credentials");
  if (u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) {
    throw new UsageError("--mirror must be a bare origin, e.g. https://mainnet-public.mirrornode.hedera.com");
  }
  const host = u.hostname.toLowerCase();
  if (FORBIDDEN_MIRROR_HOSTS.includes(host)) throw new UsageError(`--mirror ${host} is not allowed (spec §4.2)`);
  if (isOperatorHost(host)) throw new UsageError("--mirror must not be a TenPrint host (tenprint.ai or rubric-protocol.com; zero calls to our API)");
  return u.origin;
}

export interface GuardOptions {
  fetch?: FetchLike;
  /** Mirror origin, already validated. */
  mirror: string;
  topic: string;
  /** False when --keys is given: then no request to a TenPrint host is allowed at all. */
  allowKeysUrl: boolean;
}

export type GuardedFetch = (url: string) => Promise<Response>;

/** Throws NetworkGuardError unless `url` is on the §4.2 allowlist. */
export function checkAllowed(url: string, opts: Omit<GuardOptions, "fetch">): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new NetworkGuardError(url, "not a URL"); }
  if (u.protocol !== "https:") throw new NetworkGuardError(url, "not https");
  if (u.username || u.password) throw new NetworkGuardError(url, "credentials in URL");
  if (u.hash) throw new NetworkGuardError(url, "fragment in URL");
  const host = u.hostname.toLowerCase();
  if (FORBIDDEN_MIRROR_HOSTS.includes(host)) throw new NetworkGuardError(url, "forbidden mirror host");
  if (isOperatorHost(host)) {
    if (!opts.allowKeysUrl) throw new NetworkGuardError(url, "--keys given: no request to a TenPrint host");
    if (!KEYS_URLS.includes(u.href)) throw new NetworkGuardError(url, "only the static keys file may be fetched from a TenPrint host");
    return;
  }
  if (u.origin !== opts.mirror) throw new NetworkGuardError(url, "host is not the configured mirror");
  if (u.pathname !== `/api/v1/topics/${opts.topic}/messages`) {
    throw new NetworkGuardError(url, "only /api/v1/topics/<topic>/messages is allowed on the mirror");
  }
}

export function createGuardedFetch(opts: GuardOptions): GuardedFetch {
  const impl: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  return async (url: string) => {
    checkAllowed(url, opts);
    return impl(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };
}

export type JsonResult =
  | { ok: true; json: unknown }
  | { ok: false; reason: string; detail: string };

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET JSON with backoff on 429, 5xx and network errors, at most MAX_RETRIES
 * retries. A guard refusal is rethrown, never retried.
 */
export async function getJson(gf: GuardedFetch, url: string, sleep: Sleep): Promise<JsonResult> {
  let last = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), 8000));
    let res: Response;
    try {
      res = await gf(url);
    } catch (e) {
      if (e instanceof NetworkGuardError) throw e;
      last = `network error: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      last = `HTTP ${res.status}`;
      continue;
    }
    if (!res.ok) return { ok: false, reason: "HTTP_ERROR", detail: `HTTP ${res.status} from ${url}` };
    try {
      return { ok: true, json: await res.json() };
    } catch {
      return { ok: false, reason: "BAD_JSON", detail: `response from ${url} is not JSON` };
    }
  }
  return { ok: false, reason: "RETRIES_EXHAUSTED", detail: `${last} from ${url} after ${MAX_RETRIES} retries` };
}
