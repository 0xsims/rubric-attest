/**
 * Batch transport. One POST per flush to /v1/tiered-attest (tasks/P1.md).
 * The SDK reads exactly one credential env var: RUBRIC_API_KEY (CLAUDE.md).
 */
import { API_KEY_ENV, TIERED_ATTEST_PATH, type DarCore, type PayloadRecord } from "./constants.js";

export interface Transport {
  /**
   * Deliver one batch. `records` are hashes-only DAR cores; `payloads` (raw
   * content) is present only in `payload` mode and rides in the envelope, never
   * in a core. Must reject on failure so the spool retains the batch.
   */
  send(records: DarCore[], payloads?: PayloadRecord[]): Promise<void>;
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

  async send(records: DarCore[], payloads?: PayloadRecord[]): Promise<void> {
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
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`tiered-attest POST failed: ${res.status} ${res.statusText}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
