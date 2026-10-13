/**
 * Typed errors. Every failure carries a machine code (matching the backend's
 * error envelope `{"error": {"code": ...}}`) and a human hint, so a broken
 * integration reads as a clear message rather than a silent no-fill
 * (RISKS.md R10 in the backend repo).
 */
export type ErrorCode =
  // SDK-local
  | 'invalid_config'
  | 'no_fill'
  | 'network'
  | 'destroyed'
  // Backend codes, passed through
  | 'invalid_field'
  | 'unknown_placement'
  | 'format_mismatch'
  | 'unknown_impression'
  | 'out_of_order'
  | 'duplicate_impression'
  | 'wrong_format_event'
  | 'clock_skew'
  | 'click_too_fast'
  | 'invalid_render_token'
  | 'retry'
  | 'rate_limited'
  | 'temporarily_unavailable'
  | 'unknown_error';

/** Fix-it hints per backend error code. Shown alongside the server message. */
export const HINTS: Partial<Record<ErrorCode, string>> = {
  unknown_placement:
    'Check app_id and placement_id against the Naija Ads dashboard; the placement must belong to this app.',
  format_mismatch:
    'The ad_type does not match this placement. Use the format the placement was created with.',
  invalid_render_token:
    'The served creative was not the one rendered, or the impression expired (~10 min). Load a fresh ad and render exactly what the server returned.',
  unknown_impression:
    'The server has no live record of this impression (expired or placement/session mismatch). Load a fresh ad.',
  out_of_order:
    'The impression event must be accepted before click or video events. Render the ad first and wait for its "impression" event.',
  duplicate_impression:
    'This impression was already recorded. Render tokens are single-use — load a fresh ad instead of replaying.',
  wrong_format_event:
    'This event type is not valid for the placement format (e.g. video events on a banner).',
  clock_skew:
    'The device clock is ahead of server time. Client timestamps are diagnostic only — sync the device clock.',
  click_too_fast:
    'The click landed sooner than a human could manage after render, so it was discarded. Genuine clicks after a short delay are unaffected.',
  rate_limited:
    'Too many requests for this IP/app/session/placement. Respect the retry delay before sending more.',
  retry: 'The ad server is briefly unavailable. Retry shortly with the same identifiers.',
  temporarily_unavailable: 'The ad server is temporarily unavailable. Retry shortly.',
};

export interface NaijaAdsErrorOptions {
  field?: string;
  reason?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export class NaijaAdsError extends Error {
  readonly code: ErrorCode;
  readonly field?: string;
  /** No-fill / reward rejection reason from the server, when present. */
  readonly reason?: string;
  /** Set on `rate_limited` from the Retry-After header. */
  readonly retryAfterMs?: number;

  constructor(code: ErrorCode, message: string, options: NaijaAdsErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'NaijaAdsError';
    this.code = code;
    if (options.field !== undefined) this.field = options.field;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }

  /** True when the failure is transient and the exact same call may succeed later. */
  get retryable(): boolean {
    return this.code === 'retry' || this.code === 'temporarily_unavailable' || this.code === 'network';
  }
}

export function isNaijaAdsError(err: unknown): err is NaijaAdsError {
  return err instanceof NaijaAdsError;
}
