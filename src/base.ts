/**
 * Shared ad plumbing: typed event emitter + state common to every format
 * (impression lifecycle, render-token binding, click handling).
 *
 * Invariants implemented here (backend AGENTS.md §6 / ADR 0010):
 *  - the impression event carries the server-issued render_token and is sent
 *    only after the creative painted;
 *  - click/video events are only sent after the impression was accepted
 *    (server rejects out-of-order events);
 *  - the click opens exactly the served click_url — never a client-built URL;
 *  - the same event_id is reused across retries (server dedupes).
 */
import type { ApiClient } from './client';
import { NaijaAdsError } from './errors';
import { openClickUrl } from './render';
import type { AdResponse, Creative, EventWire } from './types';
import { uuid } from './uuid';

export type AdEventHandler = (payload: unknown) => void;

export class Emitter {
  private readonly handlers = new Map<string, Set<AdEventHandler>>();

  on(event: string, handler: AdEventHandler): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler: AdEventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, payload?: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      try {
        handler(payload);
      } catch {
        // A broken listener must never break the ad lifecycle.
      }
    }
  }
}

export interface AdDeps {
  client: ApiClient;
  sessionId: string;
  response: AdResponse;
  /** Called when this ad is destroyed so the owner can drop its reference. */
  onDestroy?: () => void;
}

export abstract class BaseAd {
  readonly placementId: string;
  readonly test: boolean;
  /** Server-issued impression id; changes on banner refresh. */
  impressionId: string;
  /** "WxH" for banners, null otherwise; changes on adaptive refresh. */
  size: string | null;

  protected readonly client: ApiClient;
  protected readonly sessionId: string;
  protected readonly events = new Emitter();
  protected creative: Creative | undefined;
  protected clickUrl: string | null;
  protected renderToken: string;
  protected expiresAt: number | null;
  protected destroyed = false;
  protected impressionAccepted = false;

  protected readonly onDestroy?: () => void;

  constructor(deps: AdDeps, placementId: string) {
    if (!deps.response.impressionId) {
      throw new NaijaAdsError('unknown_error', 'Fill response did not include an impression_id.');
    }
    this.client = deps.client;
    this.sessionId = deps.sessionId;
    this.onDestroy = deps.onDestroy;
    this.placementId = placementId;
    this.test = deps.response.test;
    this.impressionId = deps.response.impressionId;
    this.size = deps.response.bannerSize ?? null;
    this.creative = deps.response.creative;
    this.clickUrl = deps.response.clickUrl ?? null;
    this.renderToken = deps.response.renderToken ?? '';
    this.expiresAt = deps.response.expiresIn ? Date.now() + deps.response.expiresIn * 1000 : null;
  }

  on(event: string, handler: AdEventHandler): this {
    this.events.on(event, handler);
    return this;
  }

  off(event: string, handler: AdEventHandler): this {
    this.events.off(event, handler);
    return this;
  }

  protected emit(event: string, payload?: unknown): void {
    this.events.emit(event, payload);
  }

  protected noFillError(response: AdResponse): NaijaAdsError {
    const reason = response.reason ?? 'unknown';
    return new NaijaAdsError('no_fill', `No ad filled placement ${this.placementId} (${reason}).`, {
      reason,
    });
  }

  /** Swaps in the state of a fresh response (banner refresh). */
  protected applyResponse(response: AdResponse): void {
    if (!response.impressionId) {
      throw new NaijaAdsError('unknown_error', 'Fill response did not include an impression_id.');
    }
    this.impressionId = response.impressionId;
    this.size = response.bannerSize ?? null;
    this.creative = response.creative;
    this.clickUrl = response.clickUrl ?? null;
    this.renderToken = response.renderToken ?? '';
    this.expiresAt = response.expiresIn ? Date.now() + response.expiresIn * 1000 : null;
    this.impressionAccepted = false;
  }

  protected eventPayload(eventType: string): EventWire {
    const event: EventWire = {
      event_id: uuid(),
      event_type: eventType,
      impression_id: this.impressionId,
      placement_id: this.placementId,
      session_id: this.sessionId,
      mode: this.client.mode,
    };
    if (this.renderToken) event.render_token = this.renderToken;
    if (this.client.includeClientTime) event.client_ts = new Date().toISOString();
    return event;
  }

  /**
   * Sends the impression event. Must be called only after the creative
   * painted; live impressions carry the render token (ADR 0010). Not gated
   * on `destroyed`: once painted, the impression happened — a teardown that
   * races the attestation must never lose it.
   */
  protected async sendImpression(): Promise<void> {
    try {
      const ack = await this.client.sendEvent(this.eventPayload('impression'));
      if (ack.accepted) this.impressionAccepted = true;
      this.emit('impression');
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** Fire-and-forget click; navigation happens in the user gesture, not here. */
  protected sendClick(): void {
    if (this.destroyed || !this.impressionAccepted) return;
    void this.client.sendEvent(this.eventPayload('click')).catch(() => {
      // A dropped click event must not break the navigation that already happened.
    });
  }

  /** Opens the served click URL exactly as returned by the server (ADR 0019). */
  protected handleClick(): void {
    if (!this.clickUrl) return;
    this.emit('click', { url: this.clickUrl });
    this.sendClick();
    openClickUrl(this.clickUrl);
  }

  abstract destroy(): void;
}
