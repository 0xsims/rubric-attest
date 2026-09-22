/**
 * Batch transport. One POST per flush to /v1/tiered-attest (tasks/P1.md).
 * The SDK reads exactly one credential env var: RUBRIC_API_KEY (CLAUDE.md).
 */
import { API_KEY_ENV, TIERED_ATTEST_PATH, type DarCore } from "./constants.js";

export interface Transport {
  /** Deliver one batch. Must reject on failure so the spool retains the batch. */
  send(records: DarCore[]): Promise<void>;
}

export interface HttpTransportOptions {
  baseUrl: string;
  /** Defaults to reading process.env.RUBRIC_API_KEY at send time. */
  apiKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
}

/** Default transport: one JSON POST of the batch to `${baseUrl}/v1/tiered-attest`. */
export class HttpTransport implements Transport {
  private readonly baseUrl: string;
  private readonly apiKey: () => string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? (() => process.env[API_KEY_ENV]);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(records: DarCore[]): Promise<void> {
    const key = this.apiKey();
    if (!key) throw new Error(`${API_KEY_ENV} is not set`);
    const res = await this.fetchImpl(`${this.baseUrl}${TIERED_ATTEST_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ records }),
    });
    if (!res.ok) {
      throw new Error(`tiered-attest POST failed: ${res.status} ${res.statusText}`);
    }
  }
}
