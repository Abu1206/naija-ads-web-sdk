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
import type { AdResponse, Creative, EventAck, EventWire } from './types';
import { uuid } from './uuid';
import { ViewabilityTracker } from './viewability';
import type { ViewabilityObservation } from './viewability';

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
  private impressionPromise: Promise<void> | null = null;
  private impressionGate!: Promise<boolean>;
  private resolveImpressionGate!: (accepted: boolean) => void;
  private impressionGateSettled = false;
  private viewability: ViewabilityTracker | null = null;

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
    this.resetImpressionGate();
  }

  on(event: string, handler: AdEventHandler): this {
    this.events.on(event, handler);
    // loadBanner/loadAudio may render before the caller receives the ad object.
    // Replay settled impression state so the documented post-load subscription
    // is reliable rather than timing-dependent.
    if (event === 'impression' && this.impressionAccepted) {
      queueMicrotask(() => {
        if (this.destroyed) return;
        try {
          handler({ impressionId: this.impressionId, replay: true });
        } catch {
          // Match Emitter: publisher callbacks never break SDK lifecycle.
        }
      });
    }
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
    this.finishViewability();
    this.abandonImpression();
    this.impressionId = response.impressionId;
    this.size = response.bannerSize ?? null;
    this.creative = response.creative;
    this.clickUrl = response.clickUrl ?? null;
    this.renderToken = response.renderToken ?? '';
    this.expiresAt = response.expiresIn ? Date.now() + response.expiresIn * 1000 : null;
    this.impressionAccepted = false;
    this.impressionPromise = null;
    this.resetImpressionGate();
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

  protected assertFresh(): void {
    if (this.expiresAt !== null && Date.now() >= this.expiresAt) {
      throw new NaijaAdsError('expired', 'This loaded ad expired before it was shown. Load a fresh ad.');
    }
  }

  /**
   * Sends the impression event. Must be called only after the creative
   * painted; live impressions carry the render token (ADR 0010). Not gated
   * on `destroyed`: once painted, the impression happened — a teardown that
   * races the attestation must never lose it.
   */
  protected sendImpression(): Promise<void> {
    if (this.impressionPromise) return this.impressionPromise;
    this.impressionPromise = (async () => {
      try {
        const ack = await this.client.sendEvent(this.eventPayload('impression'));
        if (!ack.accepted) {
          throw new NaijaAdsError('unknown_error', 'The ad server did not accept the painted impression.');
        }
        this.impressionAccepted = true;
        this.settleImpressionGate(true);
        this.emit('impression', { impressionId: this.impressionId });
      } catch (err) {
        this.settleImpressionGate(false);
        this.emit('error', err);
        throw err;
      }
    })();
    return this.impressionPromise;
  }

  /** Queues follow-up events behind the accepted impression (ADR 0010). */
  protected async sendOrderedEvent(eventType: string): Promise<EventAck | undefined> {
    if (this.destroyed && eventType !== 'viewability') return undefined;
    try {
      const accepted = await this.impressionGate;
      if (!accepted || !this.impressionAccepted) return undefined;
      return await this.client.sendEvent(this.eventPayload(eventType));
    } catch (err) {
      this.emit('error', err);
      return undefined;
    }
  }

  /** Fire-and-forget click; navigation remains in the user gesture. */
  protected sendClick(): void {
    void this.sendOrderedEvent('click');
  }

  /** Opens the served click URL exactly as returned by the server (ADR 0019). */
  protected handleClick(): void {
    if (this.destroyed || (!this.test && !this.clickUrl)) return;
    this.emit('click', { url: this.clickUrl, test: this.test });
    this.sendClick();
    if (this.clickUrl) openClickUrl(this.clickUrl);
  }

  protected startViewability(
    target: HTMLElement,
    creativeKind: string,
    active?: () => boolean,
    audible?: () => boolean | undefined,
  ): void {
    this.finishViewability();
    this.viewability = new ViewabilityTracker({
      target,
      thresholdMs: creativeKind === 'video' ? 2_000 : 1_000,
      active,
      audible,
      report: (observation) => this.sendViewability(observation),
    });
    this.viewability.start();
  }

  protected viewabilityStateChanged(): void {
    this.viewability?.stateChanged();
  }

  protected finishViewability(): void {
    this.viewability?.finish();
    this.viewability = null;
  }

  /** Unblocks events that raced a dismissal or creative failure before paint. */
  protected abandonImpression(): void {
    this.settleImpressionGate(false);
  }

  private resetImpressionGate(): void {
    this.impressionGateSettled = false;
    this.impressionGate = new Promise<boolean>((resolve) => {
      this.resolveImpressionGate = resolve;
    });
  }

  private settleImpressionGate(accepted: boolean): void {
    if (this.impressionGateSettled) return;
    this.impressionGateSettled = true;
    this.resolveImpressionGate(accepted);
  }

  private sendViewability(observation: ViewabilityObservation): void {
    const event = this.eventPayload('viewability');
    event.visible_fraction_bps = observation.visibleFractionBps;
    event.continuous_visible_ms = observation.continuousVisibleMs;
    if (observation.audible !== undefined) event.audible = observation.audible;
    // The tracker only starts after impression acceptance; keepalive in the
    // client lets pagehide observations finish without blocking navigation.
    void this.client.sendEvent(event).catch((err: unknown) => this.emit('error', err));
  }

  abstract destroy(): void;
}
