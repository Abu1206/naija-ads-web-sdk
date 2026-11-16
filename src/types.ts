/**
 * Contract types. Wire types mirror the backend JSON exactly
 * (internal/ads in naija-ads-backend); public types are the camelCase
 * surface the SDK hands to developers. Renaming a wire field is a
 * cross-repo change — it needs a backend RFC (AGENTS.md §4).
 */

export type AdMode = 'test' | 'live';
export type AdType = 'banner' | 'interstitial' | 'rewarded' | 'audio';
export type DeviceType = 'phone' | 'tablet' | 'desktop';
export type BannerLayout = 'anchored' | 'inline';

// ---------------------------------------------------------------------------
// Wire types (snake_case, exactly as the Go server encodes them)
// ---------------------------------------------------------------------------

export interface AdRequestWire {
  app_id: string;
  placement_id: string;
  ad_type: string;
  session_id: string;
  mode: string;
  context: {
    country?: string;
    category?: string;
    slot_width_dp?: number;
    slot_height_dp?: number;
    device_type?: string;
  };
}

export interface CreativeWire {
  kind: string;
  mime_type: string;
  url: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  poster_url?: string | null;
  companion_url?: string | null;
  companion_size?: string | null;
  pixel_ratio?: number;
}

export interface AdResponseWire {
  fill: boolean;
  test?: boolean;
  reason?: string;
  impression_id?: string;
  ad_type?: string;
  banner_size?: string | null;
  banner_layout?: string | null;
  expires_in?: number;
  creative?: CreativeWire;
  click_url?: string | null;
  render_token?: string;
}

export interface EventWire {
  event_id: string;
  event_type: string;
  impression_id: string;
  placement_id: string;
  session_id: string;
  mode: string;
  /** Live impressions must carry the render token issued at request time (ADR 0010). */
  render_token?: string;
  /** Diagnostic only (ADR 0010); omitted by default so device clocks cannot reject events. */
  client_ts?: string;
  /** Required only for viewability observations (ADR 0018/0022). */
  visible_fraction_bps?: number;
  continuous_visible_ms?: number;
  audible?: boolean;
}

export interface RewardWire {
  status: 'confirmed' | 'rejected';
  reason?: string | null;
  reward_token?: string | null;
  impression_id: string;
}

export interface EventAckWire {
  accepted: boolean;
  duplicate?: boolean;
  reward?: RewardWire | null;
}

// ---------------------------------------------------------------------------
// Public types (camelCase SDK surface)
// ---------------------------------------------------------------------------

export interface Creative {
  kind: 'image' | 'gif' | 'video' | 'audio' | string;
  mimeType: string;
  url: string;
  width?: number;
  height?: number;
  durationMs?: number;
  posterUrl?: string;
  companionUrl?: string;
  companionSize?: string;
  pixelRatio?: number;
}

export interface AdResponse {
  fill: boolean;
  test: boolean;
  reason?: string;
  impressionId?: string;
  adType?: string;
  bannerSize?: string | null;
  bannerLayout?: BannerLayout | null;
  expiresIn?: number;
  creative?: Creative;
  clickUrl?: string | null;
  renderToken?: string;
}

export interface RewardResult {
  status: 'confirmed' | 'rejected';
  reason?: string;
  rewardToken?: string;
  impressionId: string;
}

export interface EventAck {
  accepted: boolean;
  duplicate: boolean;
  reward?: RewardResult;
}

/** Maps one wire response to the public surface. Unknown fields are dropped. */
export function mapAdResponse(wire: AdResponseWire): AdResponse {
  return {
    fill: wire.fill === true,
    test: wire.test === true,
    reason: wire.reason,
    impressionId: wire.impression_id,
    adType: wire.ad_type,
    bannerSize: wire.banner_size ?? null,
    bannerLayout:
      wire.banner_layout === 'anchored' || wire.banner_layout === 'inline'
        ? wire.banner_layout
        : null,
    expiresIn: wire.expires_in,
    creative: wire.creative ? mapCreative(wire.creative) : undefined,
    clickUrl: wire.click_url ?? null,
    renderToken: wire.render_token,
  };
}

function mapCreative(w: CreativeWire): Creative {
  return {
    kind: w.kind,
    mimeType: w.mime_type,
    url: w.url,
    width: w.width,
    height: w.height,
    durationMs: w.duration_ms,
    posterUrl: w.poster_url ?? undefined,
    companionUrl: w.companion_url ?? undefined,
    companionSize: w.companion_size ?? undefined,
    pixelRatio: w.pixel_ratio,
  };
}

export function mapEventAck(wire: EventAckWire): EventAck {
  return {
    accepted: wire.accepted === true,
    duplicate: wire.duplicate === true,
    reward: wire.reward
      ? {
          status: wire.reward.status,
          reason: wire.reward.reason ?? undefined,
          rewardToken: wire.reward.reward_token ?? undefined,
          impressionId: wire.reward.impression_id,
        }
      : undefined,
  };
}
