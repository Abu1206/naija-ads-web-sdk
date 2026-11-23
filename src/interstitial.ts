/** Full-viewport interstitials shown only at publisher-chosen natural breaks. */
import { BaseAd } from './base';
import { NaijaAdsError } from './errors';
import { activateModal, createSurface, el, waitForPaint } from './render';

export interface InterstitialOutcome {
  status: 'dismissed' | 'failed';
  reason?: string;
  impressionId: string;
  test: boolean;
}

export class InterstitialAd extends BaseAd {
  private host: HTMLElement | null = null;
  private video: HTMLVideoElement | null = null;
  private restoreModal: (() => void) | null = null;
  private pending: Promise<InterstitialOutcome> | null = null;
  private resolveShow: ((outcome: InterstitialOutcome) => void) | null = null;
  private startedSent = false;
  private completedSent = false;

  /** Shows once and resolves when dismissed or a creative fails. */
  show(): Promise<InterstitialOutcome> {
    if (this.pending) return this.pending;
    if (this.destroyed) {
      return Promise.reject(new NaijaAdsError('destroyed', 'This interstitial was destroyed. Load a new one.'));
    }
    try {
      this.assertFresh();
    } catch (err) {
      return Promise.reject(err);
    }
    this.pending = new Promise((resolve) => { this.resolveShow = resolve; });
    void this.doShow().catch((err: unknown) => {
      if (!this.resolveShow) return;
      this.emit('error', err);
      this.finish({ status: 'failed', reason: 'creative_failed', impressionId: this.impressionId, test: this.test });
    });
    return this.pending;
  }

  destroy(): void {
    if (this.resolveShow) {
      this.finish({ status: 'dismissed', impressionId: this.impressionId, test: this.test });
      return;
    }
    this.cleanup();
  }

  private async doShow(): Promise<void> {
    const surface = createSurface('overlay', 'interstitial');
    const overlay = el('div', 'naija-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', this.test ? 'Test interstitial advertisement' : 'Sponsored interstitial advertisement');

    const close = el('button', 'naija-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close ad');
    close.textContent = '×';
    close.addEventListener('click', () => this.finish({ status: 'dismissed', impressionId: this.impressionId, test: this.test }));

    const shell = el('div', 'naija-media-shell');
    const { content, paintTarget, creativeKind } = this.buildContent(overlay);
    shell.appendChild(content);
    const badge = el('span', 'naija-badge');
    badge.textContent = this.test ? 'Test ad' : 'Sponsored';
    overlay.append(shell, badge, close);
    surface.root.appendChild(overlay);
    document.body.appendChild(surface.host);
    this.host = surface.host;
    this.restoreModal = activateModal(surface, close, () => {
      this.finish({ status: 'dismissed', impressionId: this.impressionId, test: this.test });
    });
    if (this.video) this.tryPlay(overlay, this.video);

    try {
      await waitForPaint(paintTarget);
      await this.sendImpression();
      this.startViewability(
        surface.host,
        creativeKind,
        this.video ? () => !this.video!.paused && !this.video!.ended : undefined,
        this.video ? () => !this.video!.muted && this.video!.volume > 0 : undefined,
      );
    } catch (err) {
      if (this.resolveShow) {
        this.emit('error', err);
        this.finish({ status: 'failed', reason: 'creative_failed', impressionId: this.impressionId, test: this.test });
      }
    }
  }

  private finish(outcome: InterstitialOutcome): void {
    const resolve = this.resolveShow;
    if (!resolve) return;
    this.resolveShow = null;
    this.pending = null;
    this.emit(outcome.status, outcome);
    this.cleanup();
    resolve(outcome);
  }

  private cleanup(): void {
    if (this.destroyed) return;
    this.finishViewability();
    this.abandonImpression();
    this.destroyed = true;
    this.video?.pause();
    this.video = null;
    this.restoreModal?.();
    this.restoreModal = null;
    this.host?.remove();
    this.host = null;
    this.onDestroy?.();
  }

  private buildContent(overlay: HTMLElement): { content: HTMLElement; paintTarget: HTMLElement; creativeKind: string } {
    if (this.test) {
      const box = el('button', 'naija-click naija-test naija-test-full');
      box.type = 'button';
      box.setAttribute('aria-label', 'Test sponsored link');
      const title = el('p', 'naija-test-title');
      title.textContent = 'Naija Ads';
      const sub = el('p', 'naija-test-sub');
      sub.textContent = 'Test interstitial · press to test click tracking';
      box.append(title, sub);
      box.addEventListener('click', () => this.handleClick());
      return { content: box, paintTarget: box, creativeKind: 'image' };
    }
    if (!this.creative) throw new NaijaAdsError('unknown_error', 'Live fill did not include a creative.');
    if (this.creative.kind === 'video') {
      const video = this.buildVideo(overlay);
      return { content: video, paintTarget: video, creativeKind: 'video' };
    }
    if (this.creative.kind !== 'image') {
      throw new NaijaAdsError('unknown_error', 'Interstitial creative must be an image or video.');
    }
    const click = el('button', 'naija-click');
    click.type = 'button';
    click.setAttribute('aria-label', this.clickUrl ? 'Open sponsored link' : 'Sponsored image');
    const img = document.createElement('img');
    img.className = 'naija-media';
    img.src = this.creative.url;
    img.alt = 'Sponsored';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    click.appendChild(img);
    if (this.clickUrl) click.addEventListener('click', () => this.handleClick());
    else click.disabled = true;
    return { content: click, paintTarget: img, creativeKind: 'image' };
  }

  private buildVideo(overlay: HTMLElement): HTMLVideoElement {
    const video = document.createElement('video');
    video.className = 'naija-media';
    video.src = this.creative?.url ?? '';
    if (this.creative?.posterUrl) video.poster = this.creative.posterUrl;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.preload = 'auto';
    video.tabIndex = this.clickUrl ? 0 : -1;
    if (this.clickUrl) video.setAttribute('aria-label', 'Open sponsored link');

    const sound = el('button', 'naija-sound');
    sound.type = 'button';
    sound.textContent = 'Sound off';
    sound.setAttribute('aria-label', 'Turn ad sound on');
    sound.addEventListener('click', (event) => {
      event.stopPropagation();
      video.muted = !video.muted;
      sound.textContent = video.muted ? 'Sound off' : 'Sound on';
      sound.setAttribute('aria-label', video.muted ? 'Turn ad sound on' : 'Turn ad sound off');
      this.viewabilityStateChanged();
    });
    overlay.appendChild(sound);

    video.addEventListener('playing', () => {
      this.viewabilityStateChanged();
      if (this.startedSent) return;
      this.startedSent = true;
      void this.sendOrderedEvent('video_started');
    });
    video.addEventListener('pause', () => this.viewabilityStateChanged());
    video.addEventListener('ended', () => {
      this.viewabilityStateChanged();
      if (this.completedSent) return;
      this.completedSent = true;
      void this.sendOrderedEvent('video_completed');
      this.emit('completed');
    });
    video.addEventListener('click', () => this.handleClick());
    video.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.handleClick();
      }
    });
    video.addEventListener('error', () => {
      if (!this.resolveShow) return;
      this.emit('error', new NaijaAdsError('creative_failed', 'The interstitial video failed to load or play.'));
      this.finish({ status: 'failed', reason: 'video_error', impressionId: this.impressionId, test: this.test });
    });
    this.video = video;
    return video;
  }

  private tryPlay(overlay: HTMLElement, video: HTMLVideoElement): void {
    const played = video.play() as Promise<void> | undefined;
    if (played && typeof played.catch === 'function') {
      played.catch(() => this.addPlayButton(overlay, video));
    }
  }

  private addPlayButton(overlay: HTMLElement, video: HTMLVideoElement): void {
    if (!this.resolveShow || overlay.querySelector('.naija-play')) return;
    const play = el('button', 'naija-play');
    play.type = 'button';
    play.textContent = 'Play ad';
    play.addEventListener('click', () => {
      void video.play().then(() => play.remove()).catch(() => {});
    });
    overlay.appendChild(play);
    play.focus();
  }
}
