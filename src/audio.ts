/**
 * Audio ads (backend ADR 0019): MP3/AAC creative with a REQUIRED companion
 * banner. Audio placements carry no size — the companion does. Completion is
 * analytics-only: no reward, no money effect. ADR 0002 (this repo) records
 * the UI decisions: inline card, custom minimal controls, no autoplay,
 * companion banner as the only click surface.
 */
import type { AdDeps } from './base';
import { BaseAd } from './base';
import { NaijaAdsError } from './errors';
import { el, ensureStyles, parseSize, waitForPaint } from './render';

export interface AudioOptions {
  /** Render immediately into this element; otherwise call show() later. */
  container?: HTMLElement;
  /** Test-mode simulated track duration. Default 5000 ms. */
  testAudioDurationMs?: number;
}

const DEFAULT_TEST_DURATION_MS = 5000;
const MIN_TEST_DURATION_MS = 10;
const MAX_TEST_DURATION_MS = 60_000;
const TICK_MS = 50;

export class AudioAd extends BaseAd {
  private readonly testAudioDurationMs: number;
  private card: HTMLElement | null = null;
  private audio: HTMLAudioElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedSent = false;
  private completedSent = false;

  constructor(deps: AdDeps, placementId: string, options: AudioOptions = {}) {
    super(deps, placementId);
    const requested = options.testAudioDurationMs ?? DEFAULT_TEST_DURATION_MS;
    this.testAudioDurationMs = Math.min(
      MAX_TEST_DURATION_MS,
      Math.max(MIN_TEST_DURATION_MS, requested),
    );
    // Rendering happens via loadAudio (when a container is given) or an
    // explicit show() — never both, or the impression would be attested twice.
  }

  /** Renders the audio card into `container`, replacing earlier content. */
  async show(container: HTMLElement): Promise<void> {
    if (this.destroyed) throw new NaijaAdsError('destroyed', 'This audio ad was destroyed. Load a new one.');
    ensureStyles();
    container.classList.add('naija-ads-slot');
    this.card?.remove();
    this.card = this.buildCard();
    container.appendChild(this.card);
    // The card (companion + controls) is the paint surface; audio buffering
    // is not visible, so it does not gate attestation (ADR 0002 §4).
    await waitForPaint(this.card);
    await this.sendImpression();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.audio?.pause();
    this.audio = null;
    this.card?.remove();
    this.card = null;
    this.onDestroy?.();
  }

  private buildCard(): HTMLElement {
    const card = el('div', 'naija-ads-audio');
    card.appendChild(this.buildCompanion());
    if (this.test) {
      card.appendChild(this.buildTestControls());
    } else {
      card.appendChild(this.buildLiveControls());
    }
    return card;
  }

  /** ADR 0019: audio placements carry no size — the companion banner does. */
  private buildCompanion(): HTMLElement {
    if (this.test) {
      const strip = el('div', 'naija-ads-test naija-ads-test-strip');
      const label = el('p', 'naija-ads-test-sub');
      label.textContent = 'Test companion banner · Naija Ads';
      strip.appendChild(label);
      strip.addEventListener('click', () => this.handleClick());
      return strip;
    }
    if (!this.creative?.companionUrl) {
      throw new NaijaAdsError('unknown_error', 'Live audio fill did not include the required companion banner.');
    }
    const img = document.createElement('img');
    img.className = 'naija-ads-companion';
    img.src = this.creative.companionUrl;
    img.alt = 'Sponsored';
    img.referrerPolicy = 'no-referrer';
    const dims = parseSize(this.creative.companionSize ?? null);
    if (dims) {
      img.style.maxWidth = `${dims.width}px`;
      img.style.maxHeight = `${dims.height}px`;
    }
    img.addEventListener('click', () => this.handleClick());
    return img;
  }

  private buildLiveControls(): HTMLElement {
    if (!this.creative) {
      throw new NaijaAdsError('unknown_error', 'Live fill did not include a creative.');
    }
    const row = el('div', 'naija-ads-audio-row');
    const button = el('button', 'naija-ads-audio-btn');
    button.type = 'button';
    button.setAttribute('aria-label', 'Play ad');
    button.textContent = '▶';

    const audio = document.createElement('audio');
    audio.src = this.creative.url;
    audio.preload = 'auto';
    audio.style.display = 'none'; // drives state; only the custom controls are visible
    this.audio = audio;

    const bar = el('div', 'naija-ads-progress naija-ads-progress-grow');
    const fill = el('div', 'naija-ads-progress-fill');
    bar.appendChild(fill);

    const durationMs = this.creative.durationMs ?? 0;
    audio.addEventListener('playing', () => {
      button.textContent = '⏸';
      if (this.startedSent) return;
      this.startedSent = true;
      void this.client.sendEvent(this.eventPayload('audio_started')).catch(() => {});
    });
    audio.addEventListener('pause', () => {
      button.textContent = '▶';
    });
    audio.addEventListener('ended', () => {
      button.textContent = '▶';
      fill.style.width = '100%';
      if (this.completedSent) return;
      this.completedSent = true;
      void this.client.sendEvent(this.eventPayload('audio_completed')).catch(() => {});
      this.emit('completed');
    });
    audio.addEventListener('timeupdate', () => {
      if (durationMs <= 0) return;
      fill.style.width = `${Math.min(100, (audio.currentTime * 1000 / durationMs) * 100)}%`;
    });
    button.addEventListener('click', () => {
      if (audio.paused) void audio.play().catch(() => {});
      else audio.pause();
    });

    row.append(button, bar, audio);
    return row;
  }

  private buildTestControls(): HTMLElement {
    const row = el('div', 'naija-ads-audio-row');
    const button = el('button', 'naija-ads-audio-btn');
    button.type = 'button';
    button.setAttribute('aria-label', 'Play test ad');
    button.textContent = '▶';

    const bar = el('div', 'naija-ads-progress naija-ads-progress-grow');
    const fill = el('div', 'naija-ads-progress-fill');
    bar.appendChild(fill);

    let playing = false;
    let elapsed = 0;
    button.addEventListener('click', () => {
      if (playing) {
        playing = false;
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        button.textContent = '▶';
        return;
      }
      playing = true;
      button.textContent = '⏸';
      if (!this.startedSent) {
        this.startedSent = true;
        void this.client.sendEvent(this.eventPayload('audio_started')).catch(() => {});
      }
      if (this.timer !== null) return;
      this.timer = setInterval(() => {
        elapsed += TICK_MS;
        fill.style.width = `${Math.min(100, (elapsed / this.testAudioDurationMs) * 100)}%`;
        if (elapsed >= this.testAudioDurationMs) {
          playing = false;
          if (this.timer !== null) clearInterval(this.timer);
          this.timer = null;
          button.textContent = '▶';
          if (!this.completedSent) {
            this.completedSent = true;
            void this.client.sendEvent(this.eventPayload('audio_completed')).catch(() => {});
            this.emit('completed');
          }
        }
      }, TICK_MS);
    });

    row.append(button, bar);
    return row;
  }
}
