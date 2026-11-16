import { HINTS, NaijaAdsError } from './errors';
import type { ErrorCode } from './errors';
import {
  mapAdResponse,
  mapEventAck,
} from './types';
import type {
  AdMode,
  AdResponse,
  AdRequestWire,
  AdResponseWire,
  AdType,
  DeviceType,
  EventAck,
  EventAckWire,
  EventWire,
} from './types';

export interface ClientConfig {
  appId: string;
  baseUrl: string;
  mode: AdMode;
  /** Send client_ts with events (diagnostic only, ADR 0010). Off by default so
   * a wrong device clock can never reject an event via clock_skew. */
  includeClientTime?: boolean;
}

export type FetchFn = typeof fetch;
export type DelayFn = (ms: number) => Promise<void>;

const defaultFetch: FetchFn = (...args) => globalThis.fetch(...args);
const defaultDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RequestAdInput {
  placementId: string;
  adType: AdType;
  sessionId: string;
  slotWidthDp?: number;
  slotHeightDp?: number;
  deviceType?: DeviceType;
}

/**
 * Thin HTTP client for the two SDK endpoints. No credentials, no cookies —
 * the SDK routes are public and CORS-open by design (internal/ads handler).
 * All errors surface as NaijaAdsError with the backend's code.
 */
export class ApiClient {
  readonly appId: string;
  readonly mode: AdMode;
  readonly includeClientTime: boolean;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly delay: DelayFn;

  constructor(config: ClientConfig, fetchFn: FetchFn = defaultFetch, delay: DelayFn = defaultDelay) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.appId = config.appId;
    this.mode = config.mode;
    this.includeClientTime = config.includeClientTime === true;
    this.fetchFn = fetchFn;
    this.delay = delay;
  }

  /**
   * Requests one ad. Retries once on transient failures (network or 503
   * `retry`) — a no-fill is a *response*, never retried.
   */
  async requestAd(input: RequestAdInput): Promise<AdResponse> {
    const body: AdRequestWire = {
      app_id: this.appId,
      placement_id: input.placementId,
      ad_type: input.adType,
      session_id: input.sessionId,
      mode: this.mode,
      context: {
        ...(input.slotWidthDp !== undefined ? { slot_width_dp: input.slotWidthDp } : {}),
        ...(input.slotHeightDp !== undefined ? { slot_height_dp: input.slotHeightDp } : {}),
        ...(input.deviceType !== undefined ? { device_type: input.deviceType } : {}),
      },
    };
    const res = await this.postWithRetry('/v1/ads/request', body, 2, false);
    return mapAdResponse((await this.parseBody(res)) as AdResponseWire);
  }

  /**
   * Sends one event. Retries transient failures up to 3 attempts **with the
   * same event_id** — the server dedupes by event_id, so a retry can never
   * double-count (backend: "retry with the same event_id").
   */
  async sendEvent(event: EventWire): Promise<EventAck> {
    const res = await this.postWithRetry('/v1/ads/events', event, 3, true);
    return mapEventAck((await this.parseBody(res)) as EventAckWire);
  }

  private async postWithRetry(
    path: string,
    body: unknown,
    maxAttempts: number,
    keepalive: boolean,
  ): Promise<Response> {
    let lastError: unknown = new NaijaAdsError('unknown_error', 'Request loop did not run.');
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.fetchFn(this.baseUrl + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          ...(keepalive ? { keepalive: true } : {}),
        });
        if (res.status < 400) return res;
        const parsed = await this.parseErrorBody(res);
        const err = this.errorFromBody(res.status, parsed, res.headers.get('retry-after'));
        if (!err.retryable) throw err;
        lastError = err;
      } catch (err) {
        if (err instanceof NaijaAdsError && !err.retryable) throw err;
        lastError =
          err instanceof NaijaAdsError
            ? err
            : new NaijaAdsError('network', 'Network error talking to the ad server. Check baseUrl and connectivity.', { cause: err });
      }
      if (attempt < maxAttempts) {
        await this.delay(400 * 2 ** (attempt - 1));
        continue;
      }
      throw lastError;
    }
    throw lastError; // unreachable
  }

  private async parseBody(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch (err) {
      throw new NaijaAdsError('temporarily_unavailable', 'The ad server returned a non-JSON response.', { cause: err });
    }
  }

  private async parseErrorBody(res: Response): Promise<{ code: string; message?: string; field?: string; reason?: string } | null> {
    try {
      const raw = (await res.json()) as { error?: Record<string, unknown> };
      const err = raw?.error;
      if (!err || typeof err.code !== 'string') return null;
      return {
        code: err.code,
        message: typeof err.message === 'string' ? err.message : undefined,
        field: typeof err.field === 'string' ? err.field : undefined,
        reason: typeof err.reason === 'string' ? err.reason : undefined,
      };
    } catch {
      return null;
    }
  }

  private errorFromBody(status: number, parsed: { code: string; message?: string; field?: string; reason?: string } | null, retryAfterHeader: string | null = null): NaijaAdsError {
    const code = (parsed?.code ?? 'unknown_error') as ErrorCode;
    const serverMessage = parsed?.message ?? `HTTP ${status}`;
    const hint = HINTS[code];
    let retryAfterMs: number | undefined;
    if (retryAfterHeader) {
      const seconds = Number.parseInt(retryAfterHeader, 10);
      if (Number.isFinite(seconds) && seconds >= 0) retryAfterMs = seconds * 1000;
    }
    return new NaijaAdsError(code, hint ? `${serverMessage} — ${hint}` : serverMessage, {
      field: parsed?.field,
      reason: parsed?.reason,
      retryAfterMs,
    });
  }
}
