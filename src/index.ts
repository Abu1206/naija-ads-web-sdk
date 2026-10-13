/**
 * Naija Ads Web SDK — public surface (spec §7):
 *   NaijaAds.initialize({ appId, baseUrl, mode? })
 *   NaijaAds.loadBanner(placementId, options?)
 *   NaijaAds.loadInterstitial(placementId)
 *   NaijaAds.loadRewarded(placementId, options?)
 *   NaijaAds.destroyAll()
 *
 * Everything money- or auction-related happens server-side; this SDK only
 * requests, renders, attests and reports (AGENTS.md §6.4). APP_ID is public;
 * no secret ever lives here (§6.7).
 */
import type { AdDeps } from './base';
import type { BaseAd } from './base';
import { BannerAd } from './banner';
import type { BannerOptions } from './banner';
import { ApiClient } from './client';
import { NaijaAdsError } from './errors';
import { InterstitialAd } from './interstitial';
import { measureWidthDp } from './render';
import { RewardedAd } from './rewarded';
import type { RewardedOptions } from './rewarded';
import { getSessionId } from './session';
import type {
  AdMode,
  AdResponse,
  AdType,
  DeviceType,
} from './types';
import { VERSION } from './version';

export { VERSION };
export { isNaijaAdsError, NaijaAdsError } from './errors';
export type { ErrorCode } from './errors';
export type {
  AdMode,
  AdResponse,
  AdType,
  Creative,
  DeviceType,
  EventAck,
  RewardResult,
} from './types';
export type { BannerAd, BannerOptions } from './banner';
export type { InterstitialAd } from './interstitial';
export type { RewardOutcome, RewardedAd, RewardedOptions } from './rewarded';

export interface NaijaAdsConfig {
  /** Public APP_ID from the dashboard. Never a secret. */
  appId: string;
  /** Naija Ads API base URL, e.g. http://localhost:8080 (dev) or the production API host. */
  baseUrl: string;
  /** 'test' (default, safe) or 'live'. Live requires an approved app + developer (ADR 0004). */
  mode?: AdMode;
  /** Send client_ts with events (diagnostic only, ADR 0010). Default false. */
  includeClientTime?: boolean;
}

export interface NaijaAds {
  readonly sessionId: string;
  loadBanner(placementId: string, options?: BannerOptions): Promise<BannerAd>;
  loadInterstitial(placementId: string): Promise<InterstitialAd>;
  loadRewarded(placementId: string, options?: RewardedOptions): Promise<RewardedAd>;
  /** Tears down every ad created by this instance (timers, overlays, media). */
  destroyAll(): void;
}

let instance: Impl | null = null;

/** Creates (or replaces) the SDK instance. `mode` defaults to 'test'. */
export function initialize(config: NaijaAdsConfig): NaijaAds {
  if (typeof config?.appId !== 'string' || config.appId.length === 0 || config.appId.length > 128) {
    throw new NaijaAdsError(
      'invalid_config',
      'appId is required (max 128 characters). Copy the APP_ID from the Naija Ads dashboard.',
    );
  }
  if (typeof config.baseUrl !== 'string' || !/^https?:\/\//i.test(config.baseUrl)) {
    throw new NaijaAdsError(
      'invalid_config',
      'baseUrl must be an http(s) URL pointing at the Naija Ads API, e.g. http://localhost:8080.',
    );
  }
  const mode: AdMode = config.mode ?? 'test';
  if (mode !== 'test' && mode !== 'live') {
    throw new NaijaAdsError('invalid_config', 'mode must be "test" or "live".');
  }
  instance?.destroyAll();
  instance = new Impl(
    new ApiClient({ appId: config.appId, baseUrl: config.baseUrl, mode, includeClientTime: config.includeClientTime }),
    getSessionId(),
  );
  return instance;
}

/** Returns the current instance or throws with setup instructions. */
export function getInitialized(): NaijaAds {
  if (!instance) {
    throw new NaijaAdsError(
      'invalid_config',
      'Call NaijaAds.initialize({ appId, baseUrl }) before loading ads.',
    );
  }
  return instance;
}

function noFillError(placementId: string, response: AdResponse): NaijaAdsError {
  const reason = response.reason ?? 'unknown';
  return new NaijaAdsError('no_fill', `No ad filled placement ${placementId} (${reason}).`, { reason });
}

class Impl implements NaijaAds {
  readonly sessionId: string;
  private readonly client: ApiClient;
  private readonly ads = new Set<BaseAd>();

  constructor(client: ApiClient, sessionId: string) {
    this.client = client;
    this.sessionId = sessionId;
  }

  async loadBanner(placementId: string, options: BannerOptions = {}): Promise<BannerAd> {
    const slotWidthDp = options.widthDp ?? measureWidthDp(options.container);
    const response = await this.request(placementId, 'banner', slotWidthDp, options.deviceType);
    let adRef: BannerAd | undefined;
    const deps: BannerDepsInternal = {
      client: this.client,
      sessionId: this.sessionId,
      response,
      onDestroy: () => {
        if (adRef) this.ads.delete(adRef);
      },
      reload: () => this.request(placementId, 'banner', slotWidthDp, options.deviceType),
    };
    const ad = new BannerAd(deps, placementId, options);
    adRef = ad;
    this.ads.add(ad);
    if (options.container) await ad.show(options.container);
    return ad;
  }

  async loadInterstitial(placementId: string): Promise<InterstitialAd> {
    const response = await this.request(placementId, 'interstitial');
    let adRef: InterstitialAd | undefined;
    const deps: AdDeps = {
      client: this.client,
      sessionId: this.sessionId,
      response,
      onDestroy: () => {
        if (adRef) this.ads.delete(adRef);
      },
    };
    const ad = new InterstitialAd(deps, placementId);
    adRef = ad;
    this.ads.add(ad);
    return ad;
  }

  async loadRewarded(placementId: string, options: RewardedOptions = {}): Promise<RewardedAd> {
    const response = await this.request(placementId, 'rewarded');
    let adRef: RewardedAd | undefined;
    const deps: AdDeps = {
      client: this.client,
      sessionId: this.sessionId,
      response,
      onDestroy: () => {
        if (adRef) this.ads.delete(adRef);
      },
    };
    const ad = new RewardedAd(deps, placementId, options);
    adRef = ad;
    this.ads.add(ad);
    return ad;
  }

  destroyAll(): void {
    for (const ad of [...this.ads]) ad.destroy();
    this.ads.clear();
  }

  private async request(
    placementId: string,
    adType: AdType,
    slotWidthDp?: number,
    deviceType?: DeviceType,
  ): Promise<AdResponse> {
    const response = await this.client.requestAd({ placementId, adType, sessionId: this.sessionId, slotWidthDp, deviceType });
    if (!response.fill) throw noFillError(placementId, response);
    return response;
  }
}

/** Banner deps add a reload callback; structurally compatible with AdDeps. */
type BannerDepsInternal = AdDeps & { reload: () => Promise<AdResponse> };
