/** Rewarded video: user-controlled playback, server-controlled reward. */
import type { AdDeps } from './base';
import { BaseAd } from './base';
import { isNaijaAdsError, NaijaAdsError } from './errors';
import { activateModal, createSurface, el, waitForPaint } from './render';

export interface RewardOutcome {
  status: 'confirmed' | 'rejected' | 'dismissed';
  reason?: string;
  /** Verify on the publisher's backend. Absent in test mode. */
  rewardToken?: string;
  impressionId: string;
  test: boolean;
}

export interface RewardedOptions {
  /** Test-mode simulated watch duration. Default 5000 ms. */
  testVideoDurationMs?: number;
}

const DEFAULT_TEST_DURATION_MS = 5000;
const MIN_TEST_DURATION_MS = 10;
const MAX_TEST_DURATION_MS = 60_000;
const TICK_MS = 50;

export class RewardedAd extends BaseAd {
  private pending: Promise<RewardOutcome> | null = null;
  private resolveShow: ((outcome: RewardOutcome) => void) | null = null;
  private host: HTMLElement | null = null;
  private restoreModal: (() => void) | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly testVideoDurationMs: number;
  private startedSent = false;
  private completed = false;

  constructor(deps: AdDeps, placementId: string, options: RewardedOptions = {}) {
    super(deps, placementId);
    const configured = options.testVideoDurationMs ?? DEFAULT_TEST_DURATION_MS;
    const requested = Number.isFinite(configured) ? configured : DEFAULT_TEST_DURATION_MS;
    this.testVideoDurationMs = Math.min(MAX_TEST_DURATION_MS, Math.max(MIN_TEST_DURATION_MS, requested));
  }

  show(): Promise<RewardOutcome> {
    if (this.pending) return this.pending;
    if (this.destroyed) {
      return Promise.reject(new NaijaAdsError('destroyed', 'This rewarded ad was destroyed. Load a new one.'));
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
      this.finish({
        status: 'rejected', reason: isNaijaAdsError(err) ? err.code : 'creative_failed',
        impressionId: this.impressionId, test: this.test,
      });
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
    const surface = createSurface('overlay', 'rewarded');
    const overlay = el('div', 'naija-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', this.test ? 'Test rewarded advertisement' : 'Rewarded advertisement');

    const close = el('button', 'naija-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close ad without reward');
    close.textContent = '×';
    close.addEventListener('click', () => this.finish({ status: 'dismissed', impressionId: this.impressionId, test: this.test }));

    const shell = el('div', 'naija-media-shell');
    const { content, paintTarget } = this.test ? this.buildTestPlayer() : this.buildVideo(overlay);
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
        'video',
        this.test ? () => this.timer !== null : () => Boolean(this.video && !this.video.paused && !this.video.ended),
        this.test ? () => false : () => Boolean(this.video && !this.video.muted && this.video.volume > 0),
      );
      if (this.test) this.runTestPlayback();
    } catch (err) {
      if (this.resolveShow) {
        this.emit('error', err);
        this.finish({
          status: 'rejected', reason: isNaijaAdsError(err) ? err.code : 'creative_failed',
          impressionId: this.impressionId, test: this.test,
        });
      }
    }
  }

  private finish(outcome: RewardOutcome): void {
    const resolve = this.resolveShow;
    if (!resolve) return;
    this.resolveShow = null;
    this.pending = null;
    this.emit(outcome.status === 'dismissed' ? 'dismissed' : 'rewarded', outcome);
    this.cleanup();
    resolve(outcome);
  }

  private cleanup(): void {
    if (this.destroyed) return;
    this.finishViewability();
    this.abandonImpression();
    this.destroyed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.video?.pause();
    this.video = null;
    this.restoreModal?.();
    this.restoreModal = null;
    this.host?.remove();
    this.host = null;
    this.onDestroy?.();
  }

  private async completeVideo(): Promise<void> {
    if (this.destroyed || this.completed) return;
    this.completed = true;
    const ack = await this.sendOrderedEvent('video_completed');
    const reward = ack?.reward;
    let outcome: RewardOutcome;
    if (reward?.status === 'confirmed') {
      outcome = {
        status: 'confirmed', rewardToken: reward.rewardToken,
        impressionId: reward.impressionId, test: this.test,
      };
    } else if (reward?.status === 'rejected') {
      outcome = { status: 'rejected', reason: reward.reason, impressionId: this.impressionId, test: this.test };
    } else {
      outcome = this.test
        ? { status: 'confirmed', impressionId: this.impressionId, test: true }
        : { status: 'rejected', reason: 'no_decision', impressionId: this.impressionId, test: false };
    }
    this.finish(outcome);
  }

  private buildVideo(overlay: HTMLElement): { content: HTMLVideoElement; paintTarget: HTMLVideoElement } {
    if (!this.creative || this.creative.kind !== 'video') {
      throw new NaijaAdsError('unknown_error', 'Rewarded fill did not include a video creative.');
    }
    const video = document.createElement('video');
    video.className = 'naija-media';
    video.src = this.creative.url;
    if (this.creative.posterUrl) video.poster = this.creative.posterUrl;
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
      void this.completeVideo();
    });
    video.addEventListener('click', () => this.handleClick());
    video.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.handleClick();
      }
    });
    video.addEventListener('error', () => {
      this.emit('error', new NaijaAdsError('creative_failed', 'The rewarded video failed to load or play.'));
      this.finish({ status: 'rejected', reason: 'video_error', impressionId: this.impressionId, test: this.test });
    });
    this.video = video;
    return { content: video, paintTarget: video };
  }

  private tryPlay(overlay: HTMLElement, video: HTMLVideoElement): void {
    const played = video.play() as Promise<void> | undefined;
    if (played && typeof played.catch === 'function') played.catch(() => this.addPlayButton(overlay, video));
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

  private buildTestPlayer(): { content: HTMLElement; paintTarget: HTMLElement } {
    const box = el('div', 'naija-test naija-test-full');
    const title = el('p', 'naija-test-title');
    title.textContent = 'Naija Ads';
    const sub = el('p', 'naija-test-sub');
    sub.textContent = `Test rewarded video · ${Math.round(this.testVideoDurationMs / 1000)}s`;
    const bar = el('div', 'naija-progress');
    const fill = el('div', 'naija-progress-fill');
    bar.appendChild(fill);
    box.append(title, sub, bar);
    this.runTestPlayback = () => {
      if (!this.startedSent) {
        this.startedSent = true;
        void this.sendOrderedEvent('video_started');
      }
      let elapsed = 0;
      this.timer = setInterval(() => {
        elapsed += TICK_MS;
        fill.style.width = `${Math.min(100, (elapsed / this.testVideoDurationMs) * 100)}%`;
        this.viewabilityStateChanged();
        if (elapsed >= this.testVideoDurationMs && this.timer !== null) {
          clearInterval(this.timer);
          this.timer = null;
          void this.completeVideo();
        }
      }, TICK_MS);
    };
    return { content: box, paintTarget: box };
  }

  private runTestPlayback: () => void = () => {};
}
