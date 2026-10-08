/**
 * Batch transport. One POST per flush to /v1/tiered-attest (tasks/P1.md).
 * The SDK reads exactly one credential env var: RUBRIC_API_KEY (CLAUDE.md).
 *
 * Every batch POST carries `x-rubric-sdk: attest-decision/<version>`; the server
 * answers 426 to a missing or pre-1.2.0 header. Every batch response carries the
 * caller's `namespace`, which the transport hands back to the Attestor to check.
 */
import {
  API_KEY_ENV,
  SDK_NAME,
  SDK_VERSION,
  SDK_VERSION_HEADER,
  TIERED_ATTEST_PATH,
  type DarCore,
  type PayloadRecord,
} from "./constants.js";

/** A record the server refused under a 200. Permanent: resending cannot fix it. */
export interface RejectedRecord {
  decisionId: string | null;
  reason: string;
}

/** What a delivered batch reports back. Every field is optional. */
export interface SendResult {
  /** The namespace the server answered with (`null`: none on that node); absent if unknown. */
  namespace?: string | null;
  accepted?: string[];
  /** Permanent rejects: the batch was delivered, these records will never be stored. */
  rejected?: RejectedRecord[];
}

export interface Transport {
  /**
   * Deliver one batch. `records` are hashes-only DAR cores; `payloads` (raw
   * content) is present only in `payload` mode and rides in the envelope, never
   * in a core. Must reject on failure so the spool retains the batch; a
   * rejection may be a TransportError carrying the server's `namespace`.
   * Resolving (with or without a SendResult) means the batch is final.
   */
  send(records: DarCore[], payloads?: PayloadRecord[]): Promise<SendResult | void>;
}

/** A non-2xx batch response (or a failed request). The batch stays spooled and is retried. */
export class TransportError extends Error {
  /** HTTP status, when a response arrived. */
  readonly status?: number;
  /** The server's error code, e.g. `SDK_UPGRADE_REQUIRED`, `BATCH_INGEST_NOT_ENABLED`, `NAMESPACE_UNAVAILABLE`. */
  readonly code?: string;
  /** The response's `namespace` (`null`: none on that node); absent if the body had none. */
  readonly namespace?: string | null;
  /** From a `Retry-After` header, in ms. */
  readonly retryAfterMs?: number;
  /** Parsed JSON body, if any. */
  readonly body?: unknown;

  constructor(
    message: string,
    details: { status?: number; code?: string; namespace?: string | null; retryAfterMs?: number; body?: unknown } = {},
  ) {
    super(message);
    this.name = "TransportError";
    this.status = details.status;
    this.code = details.code;
    if ("namespace" in details) this.namespace = details.namespace;
    this.retryAfterMs = details.retryAfterMs;
    this.body = details.body;
  }
}

export interface HttpTransportOptions {
  baseUrl: string;
  /** Defaults to reading process.env.RUBRIC_API_KEY at send time. */
  apiKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
  /** Abort a POST after this many ms so a hung endpoint can't stall flushing. Default 30000. */
  timeoutMs?: number;
  /** Permit a non-HTTPS baseUrl (localhost is always allowed). Default false. */
  allowInsecure?: boolean;
}

function isLocalhost(u: URL): boolean {
  return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** `namespace` from a response body: a string, `null`, or absent (undefined). */
function namespaceOf(body: unknown): string | null | undefined {
  if (!isObject(body) || !("namespace" in body)) return undefined;
  const ns = body.namespace;
  return typeof ns === "string" || ns === null ? ns : undefined;
}

function rejectedOf(body: unknown): RejectedRecord[] {
  if (!isObject(body) || !Array.isArray(body.rejected)) return [];
  return body.rejected.filter(isObject).map((r) => ({
    decisionId: typeof r.decisionId === "string" ? r.decisionId : null,
    reason: typeof r.reason === "string" ? r.reason : "unknown",
  }));
}

function retryAfterMsOf(res: Response): number | undefined {
  const h = res.headers?.get?.("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** The server's own words for a non-2xx: `<status> <code>: <error> <hint>`, plus 426's minimum. */
function describeFailure(res: Response, body: unknown): string {
  const b = isObject(body) ? body : {};
  const str = (k: string): string | undefined => (typeof b[k] === "string" ? (b[k] as string) : undefined);
  let msg = `tiered-attest POST failed: ${res.status} ${str("code") ?? res.statusText}`.trimEnd();
  const detail = [str("error"), str("hint")].filter(Boolean).join(" ");
  if (detail) msg += `: ${detail}`;
  if (res.status === 426) {
    msg += ` (minimum ${str("minimum") ?? "unknown"}, this SDK sent ${SDK_NAME}/${SDK_VERSION})`;
  }
  return msg;
}

/** Default transport: one JSON POST of the batch to `${baseUrl}/v1/tiered-attest`. */
export class HttpTransport implements Transport {
  private readonly baseUrl: string;
  private readonly apiKey: () => string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    // Refuse to send the bearer credential over cleartext unless explicitly allowed.
    const parsed = new URL(this.baseUrl);
    if (parsed.protocol !== "https:" && !isLocalhost(parsed) && !options.allowInsecure) {
      throw new Error(
        `HttpTransport: refusing non-HTTPS baseUrl '${this.baseUrl}' (set allowInsecure to override)`,
      );
    }
    this.apiKey = options.apiKey ?? (() => process.env[API_KEY_ENV]);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async send(records: DarCore[], payloads?: PayloadRecord[]): Promise<SendResult> {
    const key = this.apiKey();
    if (!key) throw new Error(`${API_KEY_ENV} is not set`);

    const body = payloads && payloads.length > 0 ? { records, payloads } : { records };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${TIERED_ATTEST_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
          [SDK_VERSION_HEADER]: `${SDK_NAME}/${SDK_VERSION}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = undefined; // not JSON (a proxy's error page, an empty body)
      }
      if (!res.ok) {
        throw new TransportError(describeFailure(res, parsed), {
          status: res.status,
          code: isObject(parsed) && typeof parsed.code === "string" ? parsed.code : undefined,
          ...(namespaceOf(parsed) !== undefined ? { namespace: namespaceOf(parsed) } : {}),
          retryAfterMs: retryAfterMsOf(res),
          body: parsed,
        });
      }
      const ns = namespaceOf(parsed);
      return {
        ...(ns !== undefined ? { namespace: ns } : {}),
        accepted:
          isObject(parsed) && Array.isArray(parsed.accepted)
            ? parsed.accepted.filter((x): x is string => typeof x === "string")
            : [],
        rejected: rejectedOf(parsed),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
