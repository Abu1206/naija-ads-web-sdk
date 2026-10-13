/**
 * Rewarded video: the player watches, the SERVER validates. The SDK sends
 * video_started / video_completed and hands the developer whatever the
 * server decided — `reward_token` on confirmation, a reason on rejection.
 * The game's own backend must verify that token against
 * POST /v1/rewards/verify (Bearer SDK secret, server-to-server only) before
 * granting anything. `video_completed ≠ reward` (backend AGENTS.md §6.5).
 */
import type { AdDeps } from './base';
import { BaseAd } from './base';
import { NaijaAdsError } from './errors';
import { el, ensureStyles, waitForPaint } from './render';
import { isNaijaAdsError } from './errors';

export interface RewardOutcome {
  status: 'confirmed' | 'rejected' | 'dismissed';
  reason?: string;
  /** Verify this on the game's backend via POST /v1/rewards/verify. Absent in test mode. */
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
  private overlay: HTMLElement | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly testVideoDurationMs: number;

  constructor(deps: AdDeps, placementId: string, options: RewardedOptions = {}) {
    super(deps, placementId);
    const requested = options.testVideoDurationMs ?? DEFAULT_TEST_DURATION_MS;
    this.testVideoDurationMs = Math.min(
      MAX_TEST_DURATION_MS,
      Math.max(MIN_TEST_DURATION_MS, requested),
    );
  }

  /**
   * Shows the rewarded ad and resolves when the server decides the reward,
   * the player dismisses early, or playback fails. The outcome is the
   * server's decision — never a client-side judgment.
   */
  show(): Promise<RewardOutcome> {
    if (this.pending) return this.pending;
    if (this.destroyed) {
      return Promise.reject(new NaijaAdsError('destroyed', 'This rewarded ad was destroyed. Load a new one.'));
    }
    let resolveShow!: (outcome: RewardOutcome) => void;
    const outcome = new Promise<RewardOutcome>((resolve) => {
      resolveShow = resolve;
    });
    // Assigned synchronously: a dismiss/error that lands before the creative
    // paints must still resolve the caller (never a dropped decision).
    this.resolveShow = resolveShow;
    this.pending = outcome;
    void this.doShow().catch((err: unknown) => this.emit('error', err));
    return outcome;
  }

  destroy(): void {
    if (this.resolveShow !== null) {
      // Show() is pending: treat an explicit destroy as an early dismissal.
      this.finish({ status: 'dismissed', impressionId: this.impressionId, test: this.test });
      return;
    }
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.video?.pause();
    this.video = null;
    this.overlay?.remove();
    this.overlay = null;
    this.onDestroy?.();
  }

  private async doShow(): Promise<void> {
    ensureStyles();
    const overlay = el('div', 'naija-ads-overlay');
    const close = el('button', 'naija-ads-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close ad');
    close.textContent = '×';
    close.disabled = true; // unlock on completion, playback failure or blocked autoplay
    close.addEventListener('click', () => this.finish({ status: 'dismissed', impressionId: this.impressionId, test: this.test }));
    overlay.appendChild(close);
    if (this.test) overlay.appendChild(this.buildTestPlayer());
    else overlay.appendChild(this.buildVideo(close));
    document.body.appendChild(overlay);
    this.overlay = overlay;

    const target = overlay.querySelector('img, video');
    await waitForPaint(target instanceof HTMLElement ? target : overlay);
    await this.sendImpression();
    if (this.test) this.runTestPlayback();
  }

  private finish(outcome: RewardOutcome): void {
    const resolve = this.resolveShow;
    if (resolve === null) return; // already finished
    this.resolveShow = null;
    this.pending = null;
    this.emit(outcome.status === 'dismissed' ? 'dismissed' : 'rewarded', outcome);
    this.destroy();
    resolve(outcome);
  }

  private async completeVideo(): Promise<void> {
    if (this.destroyed) return;
    let outcome: RewardOutcome;
    try {
      const ack = await this.client.sendEvent(this.eventPayload('video_completed'));
      const reward = ack.reward;
      if (reward?.status === 'confirmed') {
        outcome = {
          status: 'confirmed',
          rewardToken: reward.rewardToken,
          impressionId: reward.impressionId,
          test: this.test,
        };
      } else if (reward?.status === 'rejected') {
        outcome = { status: 'rejected', reason: reward.reason, impressionId: this.impressionId, test: this.test };
      } else {
        // Test mode has no server reward decision; a live rewarded fill always decides.
        outcome = this.test
          ? { status: 'confirmed', impressionId: this.impressionId, test: true }
          : { status: 'rejected', reason: 'no_decision', impressionId: this.impressionId, test: false };
      }
    } catch (err) {
      this.emit('error', err);
      outcome = {
        status: 'rejected',
        reason: isNaijaAdsError(err) ? err.code : 'event_failed',
        impressionId: this.impressionId,
        test: this.test,
      };
    }
    this.finish(outcome);
  }

  private buildVideo(close: HTMLButtonElement): HTMLVideoElement {
    const video = document.createElement('video');
    video.className = 'naija-ads-media';
    video.src = this.creative?.url ?? '';
    if (this.creative?.posterUrl) video.poster = this.creative.posterUrl;
    video.muted = true; // autoplay policy; web-game rewarded video stays muted
    video.playsInline = true;
    video.autoplay = true;
    video.preload = 'auto';
    video.addEventListener('playing', () => {
      void this.client.sendEvent(this.eventPayload('video_started')).catch(() => {});
    });
    video.addEventListener('ended', () => {
      void this.completeVideo();
    });
    video.addEventListener('error', () => {
      close.disabled = false;
      this.emit('error', new NaijaAdsError('unknown_error', 'The rewarded video failed to load or play.'));
      this.finish({ status: 'rejected', reason: 'video_error', impressionId: this.impressionId, test: this.test });
    });
    this.video = video;
    const played = video.play() as Promise<void> | undefined;
    if (played && typeof played.catch === 'function') {
      played.catch(() => {
        // Autoplay blocked: let the player tap to start; allow leaving meanwhile.
        close.disabled = false;
        video.addEventListener('click', () => void video.play().catch(() => {}));
      });
    }
    return video;
  }

  private buildTestPlayer(): HTMLElement {
    const box = el('div', 'naija-ads-test naija-ads-test-full');
    const title = el('p', 'naija-ads-test-title');
    title.textContent = 'Naija Ads';
    const sub = el('p', 'naija-ads-test-sub');
    sub.textContent = `Test rewarded video · ${Math.round(this.testVideoDurationMs / 1000)}s`;
    const bar = el('div', 'naija-ads-progress');
    const fill = el('div', 'naija-ads-progress-fill');
    bar.appendChild(fill);
    box.append(title, sub, bar);
    this.runTestPlayback = () => {
      void this.client.sendEvent(this.eventPayload('video_started')).catch(() => {});
      let elapsed = 0;
      this.timer = setInterval(() => {
        elapsed += TICK_MS;
        fill.style.width = `${Math.min(100, (elapsed / this.testVideoDurationMs) * 100)}%`;
        if (elapsed >= this.testVideoDurationMs && this.timer !== null) {
          clearInterval(this.timer);
          this.timer = null;
          void this.completeVideo();
        }
      }, TICK_MS);
    };
    return box;
  }

  private runTestPlayback: () => void = () => {};
}
