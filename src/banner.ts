/**
 * Banner ads — first-class MVP format. Fixed slots render the served size;
 * adaptive slots report the container width so the server picks the best
 * fitting size (ADR 0012). Refresh re-requests a fresh impression; the old
 * one simply expires server-side (~10 min).
 */
import type { AdDeps } from './base';
import { BaseAd } from './base';
import { NaijaAdsError } from './errors';
import { el, ensureStyles, parseSize, waitForPaint } from './render';
import type { AdResponse, DeviceType } from './types';

export interface BannerOptions {
  /** Render immediately into this element; otherwise call show() later. */
  container?: HTMLElement;
  /** Adaptive slots: explicit slot width override; default measures the container. */
  widthDp?: number;
  deviceType?: DeviceType;
  /** Auto-refresh every N ms. 0 (default) disables. Minimum 15 s. */
  refreshIntervalMs?: number;
}

export interface BannerDeps extends AdDeps {
  /** Requests a fresh ad for refresh cycles (same placement + context). */
  reload: () => Promise<AdResponse>;
}

const MIN_REFRESH_MS = 15_000;

export class BannerAd extends BaseAd {
  private readonly reload: () => Promise<AdResponse>;
  private readonly refreshMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private slot: HTMLElement | null = null;
  private node: HTMLElement | null = null;

  constructor(deps: BannerDeps, placementId: string, options: BannerOptions = {}) {
    super(deps, placementId);
    this.reload = deps.reload;
    const refresh = options.refreshIntervalMs ?? 0;
    if (refresh !== 0 && refresh < MIN_REFRESH_MS) {
      throw new NaijaAdsError(
        'invalid_config',
        `refreshIntervalMs must be 0 (disabled) or at least ${MIN_REFRESH_MS} to keep impressions viewable.`,
      );
    }
    this.refreshMs = refresh;
    this.scheduleRefresh();
  }

  /** Renders into `slot`, replacing earlier content, then sends the impression. */
  async show(slot: HTMLElement): Promise<void> {
    if (this.destroyed) throw new NaijaAdsError('destroyed', 'This banner was destroyed. Load a new one.');
    ensureStyles();
    slot.classList.add('naija-ads-slot');
    this.slot = slot;
    this.node?.remove();
    this.node = this.buildNode();
    slot.appendChild(this.node);
    this.scheduleRefresh();
    const img = this.node.querySelector('img');
    await waitForPaint(img instanceof HTMLImageElement ? img : this.node);
    await this.sendImpression();
  }

  /** Re-requests an ad and re-renders in place. Errors surface on 'error'. */
  async refresh(): Promise<void> {
    if (this.destroyed || !this.slot) return;
    const response = await this.reload();
    if (this.destroyed) return;
    if (!response.fill) {
      this.emit('error', this.noFillError(response));
      return;
    }
    this.applyResponse(response);
    await this.show(this.slot);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.node?.remove();
    this.node = null;
    this.slot = null;
    this.onDestroy?.();
  }

  private scheduleRefresh(): void {
    if (this.refreshMs <= 0 || this.timer !== null || this.destroyed) return;
    this.timer = setInterval(() => {
      void this.refresh().catch((err: unknown) => this.emit('error', err));
    }, this.refreshMs);
  }

  private buildNode(): HTMLElement {
    if (this.test) {
      const box = el('div', 'naija-ads-test');
      const dims = parseSize(this.size) ?? { width: 320, height: 50 };
      box.style.width = `${dims.width}px`;
      box.style.height = `${dims.height}px`;
      const title = el('p', 'naija-ads-test-title');
      title.textContent = 'Naija Ads';
      const sub = el('p', 'naija-ads-test-sub');
      sub.textContent = `Test banner · ${dims.width}×${dims.height}`;
      box.append(title, sub);
      box.addEventListener('click', () => this.handleClick());
      return box;
    }
    if (!this.creative) {
      throw new NaijaAdsError('unknown_error', 'Live fill did not include a creative.');
    }
    const img = document.createElement('img');
    img.className = 'naija-ads-banner-img';
    img.src = this.creative.url;
    img.alt = 'Sponsored';
    img.referrerPolicy = 'no-referrer';
    if (this.creative.width !== undefined) img.width = this.creative.width;
    if (this.creative.height !== undefined) img.height = this.creative.height;
    const wrap = el('div', 'naija-ads-banner');
    wrap.appendChild(img);
    wrap.addEventListener('click', () => this.handleClick());
    return wrap;
  }
}
