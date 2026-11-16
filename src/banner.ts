/** Layout-safe fixed/adaptive banners (backend ADR 0012/0022). */
import type { AdDeps } from './base';
import { BaseAd } from './base';
import { NaijaAdsError } from './errors';
import { createSurface, el, measureWidthDp, parseSize, waitForPaint } from './render';
import type { AdResponse, BannerLayout, DeviceType } from './types';

export interface BannerOptions {
  /** Render immediately into this element; otherwise call show() later. */
  container?: HTMLElement;
  /** Placement layout. Send this so the first request can apply a safe height ceiling. */
  layout?: BannerLayout;
  /** Explicit slot width/height ceiling in CSS pixels. */
  widthDp?: number;
  maxHeightDp?: number;
  deviceType?: DeviceType;
  /** Visible on-screen time between requests. 0 (default) disables; minimum 30s. */
  refreshIntervalMs?: number;
  /** Re-request after material container-width changes. Default true. */
  autoResize?: boolean;
}

export interface BannerDeps extends AdDeps {
  /** Requests a fresh ad using current slot geometry. */
  reload: (slot: HTMLElement | null) => Promise<AdResponse>;
}

const MIN_REFRESH_MS = 30_000;
const TICK_MS = 1_000;
const RESIZE_DEBOUNCE_MS = 200;

export function validateBannerOptions(options: BannerOptions): void {
  const refresh = options.refreshIntervalMs ?? 0;
  if (!Number.isFinite(refresh) || (refresh !== 0 && refresh < MIN_REFRESH_MS)) {
    throw new NaijaAdsError(
      'invalid_config',
      `refreshIntervalMs must be 0 (disabled) or at least ${MIN_REFRESH_MS}; 60 seconds is recommended.`,
    );
  }
  if (options.layout !== undefined && options.layout !== 'anchored' && options.layout !== 'inline') {
    throw new NaijaAdsError('invalid_config', 'Banner layout must be "anchored" or "inline".');
  }
  for (const [name, value] of [['widthDp', options.widthDp], ['maxHeightDp', options.maxHeightDp]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 1 || value > 4096)) {
      throw new NaijaAdsError('invalid_config', `${name} must be between 1 and 4096 CSS pixels.`);
    }
  }
}

export class BannerAd extends BaseAd {
  private readonly reload: (slot: HTMLElement | null) => Promise<AdResponse>;
  private readonly refreshMs: number;
  private readonly autoResize: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private intersection: IntersectionObserver | null = null;
  private resize: ResizeObserver | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private slot: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private visible = false;
  private visibleMs = 0;
  private measuredWidth: number | undefined;
  private attemptedImpressionId: string | null = null;

  constructor(deps: BannerDeps, placementId: string, options: BannerOptions = {}) {
    super(deps, placementId);
    this.reload = deps.reload;
    validateBannerOptions(options);
    const refresh = options.refreshIntervalMs ?? 0;
    this.refreshMs = refresh;
    this.autoResize = options.autoResize !== false && options.widthDp === undefined;
  }

  /** Renders one server response into `slot`, then attests paint. */
  async show(slot: HTMLElement): Promise<void> {
    if (this.destroyed) throw new NaijaAdsError('destroyed', 'This banner was destroyed. Load a new one.');
    this.assertFresh();
    if (this.attemptedImpressionId === this.impressionId) {
      throw new NaijaAdsError('invalid_config', 'This banner response was already shown. Call refresh() for a new impression.');
    }
    this.attemptedImpressionId = this.impressionId;
    this.slot = slot;
    this.measuredWidth = measureWidthDp(slot);
    this.host?.remove();

    const surface = createSurface('inline', 'banner');
    this.host = surface.host;
    try {
      const { node, paintTarget } = this.buildNode();
      surface.root.appendChild(node);
      slot.appendChild(surface.host);
      await waitForPaint(paintTarget);
      await this.sendImpression();
      this.startViewability(surface.host, 'image');
      this.observeVisibility();
      this.observeResize();
      this.scheduleRefresh();
    } catch (err) {
      this.abandonImpression();
      surface.host.remove();
      if (this.host === surface.host) this.host = null;
      throw err;
    }
  }

  /** Re-requests with current geometry and swaps only after a valid fill. */
  async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.performRefresh();
    this.refreshInFlight = pending.finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<void> {
    if (this.destroyed || !this.slot) return;
    const response = await this.reload(this.slot);
    if (this.destroyed) return;
    if (!response.fill) {
      this.emit('error', this.noFillError(response));
      return;
    }
    this.visibleMs = 0;
    this.applyResponse(response);
    await this.show(this.slot);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.finishViewability();
    this.abandonImpression();
    this.destroyed = true;
    this.clearObservers();
    this.host?.remove();
    this.host = null;
    this.slot = null;
    this.onDestroy?.();
  }

  private scheduleRefresh(): void {
    if (this.refreshMs <= 0 || this.timer !== null || this.destroyed) return;
    this.timer = setInterval(() => {
      if (!this.visible || document.visibilityState !== 'visible') return;
      this.visibleMs += TICK_MS;
      if (this.visibleMs < this.refreshMs) return;
      this.visibleMs = 0;
      void this.refresh().catch((err: unknown) => this.emit('error', err));
    }, TICK_MS);
  }

  private observeVisibility(): void {
    this.intersection?.disconnect();
    this.intersection = null;
    this.visible = false;
    if (!this.host) return;
    if (typeof IntersectionObserver !== 'function') {
      this.visible = true;
      return;
    }
    this.intersection = new IntersectionObserver((entries) => {
      const entry = entries[0];
      this.visible = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.5);
    }, { threshold: [0, 0.5] });
    this.intersection.observe(this.host);
  }

  private observeResize(): void {
    this.resize?.disconnect();
    this.resize = null;
    if (!this.slot || !this.autoResize || typeof ResizeObserver !== 'function') return;
    this.resize = new ResizeObserver(() => {
      if (!this.slot || this.destroyed) return;
      const next = measureWidthDp(this.slot);
      if (next === undefined || this.measuredWidth === undefined || Math.abs(next - this.measuredWidth) < 2) return;
      this.measuredWidth = next;
      if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = null;
        void this.refresh().catch((err: unknown) => this.emit('error', err));
      }, RESIZE_DEBOUNCE_MS);
    });
    this.resize.observe(this.slot);
  }

  private clearObservers(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.timer = null;
    this.resizeTimer = null;
    this.intersection?.disconnect();
    this.resize?.disconnect();
    this.intersection = null;
    this.resize = null;
  }

  private buildNode(): { node: HTMLElement; paintTarget: HTMLElement } {
    const dims = parseSize(this.size);
    if (!dims) throw new NaijaAdsError('unknown_error', 'Banner fill did not include a valid logical banner_size.');

    const frame = el('div', 'naija-frame');
    frame.style.width = `${dims.width}px`;
    frame.style.aspectRatio = `${dims.width} / ${dims.height}`;
    frame.setAttribute('aria-label', `Sponsored banner, ${dims.width} by ${dims.height}`);

    let content: HTMLElement;
    let paintTarget: HTMLElement;
    if (this.test) {
      const box = el('div', 'naija-test');
      const title = el('p', 'naija-test-title');
      title.textContent = 'Naija Ads';
      const sub = el('p', 'naija-test-sub');
      sub.textContent = `Test banner · ${dims.width}×${dims.height}`;
      box.append(title, sub);
      content = box;
      paintTarget = box;
    } else {
      if (!this.creative || (this.creative.kind !== 'image' && this.creative.kind !== 'gif')) {
        throw new NaijaAdsError('unknown_error', 'Live banner fill did not include an image or GIF creative.');
      }
      const img = document.createElement('img');
      img.className = 'naija-banner-img';
      img.src = this.creative.url;
      img.alt = 'Sponsored';
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      if (this.creative.width !== undefined) img.width = this.creative.width;
      if (this.creative.height !== undefined) img.height = this.creative.height;
      content = img;
      paintTarget = img;
    }

    if (this.test || this.clickUrl) {
      const click = el('button', 'naija-click');
      click.type = 'button';
      click.setAttribute('aria-label', this.test ? 'Test sponsored link' : 'Open sponsored link');
      click.appendChild(content);
      click.addEventListener('click', () => this.handleClick());
      frame.appendChild(click);
    } else {
      frame.appendChild(content);
    }
    const badge = el('span', 'naija-badge');
    badge.textContent = this.test ? 'Test ad' : 'Sponsored';
    frame.appendChild(badge);
    return { node: frame, paintTarget };
  }
}
