/**
 * Interstitial ads: full-screen image or video at natural breaks.
 * Video progress is analytics-only here (no reward, no money effect —
 * ADR 0014). Closable at any time; video starts muted (browser autoplay
 * policy) and a tap plays it when autoplay was blocked.
 */
import { BaseAd } from './base';
import { NaijaAdsError } from './errors';
import { el, ensureStyles, waitForPaint } from './render';

export class InterstitialAd extends BaseAd {
  private overlay: HTMLElement | null = null;
  private video: HTMLVideoElement | null = null;
  private startedSent = false;

  /** Renders the full-screen overlay and sends the impression once painted. */
  async show(): Promise<void> {
    if (this.destroyed) throw new NaijaAdsError('destroyed', 'This interstitial was destroyed. Load a new one.');
    if (this.overlay) return; // already showing
    ensureStyles();

    const overlay = el('div', 'naija-ads-overlay');
    const close = el('button', 'naija-ads-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close ad');
    close.textContent = '×';
    close.addEventListener('click', () => {
      this.emit('dismissed');
      this.destroy();
    });
    overlay.appendChild(close);
    overlay.appendChild(this.buildContent());
    document.body.appendChild(overlay);
    this.overlay = overlay;

    const target = overlay.querySelector('img, video');
    await waitForPaint(target instanceof HTMLElement ? target : overlay);
    await this.sendImpression();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.video?.pause();
    this.video = null;
    this.overlay?.remove();
    this.overlay = null;
    this.onDestroy?.();
  }

  private buildContent(): HTMLElement {
    if (this.test) {
      const box = el('div', 'naija-ads-test naija-ads-test-full');
      const title = el('p', 'naija-ads-test-title');
      title.textContent = 'Naija Ads';
      const sub = el('p', 'naija-ads-test-sub');
      sub.textContent = 'Test interstitial · tap to test click-through';
      box.append(title, sub);
      box.addEventListener('click', () => this.handleClick());
      return box;
    }
    if (!this.creative) {
      throw new NaijaAdsError('unknown_error', 'Live fill did not include a creative.');
    }
    if (this.creative.kind === 'video') return this.buildVideo();
    return this.buildImage();
  }

  private buildImage(): HTMLElement {
    const img = document.createElement('img');
    img.className = 'naija-ads-media';
    img.src = this.creative?.url ?? '';
    img.alt = 'Sponsored';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('click', () => this.handleClick());
    return img;
  }

  private buildVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    video.className = 'naija-ads-media';
    video.src = this.creative?.url ?? '';
    if (this.creative?.posterUrl) video.poster = this.creative.posterUrl;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.preload = 'auto';
    video.addEventListener('playing', () => {
      if (this.startedSent) return;
      this.startedSent = true;
      void this.client.sendEvent(this.eventPayload('video_started')).catch(() => {});
    });
    video.addEventListener('ended', () => {
      void this.client.sendEvent(this.eventPayload('video_completed')).catch(() => {});
    });
    video.addEventListener('click', () => {
      // A paused video means autoplay was blocked: the tap means "play".
      if (video.paused) {
        void video.play().catch(() => {});
        return;
      }
      this.handleClick();
    });
    this.video = video;
    const played = video.play() as Promise<void> | undefined;
    if (played && typeof played.catch === 'function') played.catch(() => {});
    return video;
  }
}
