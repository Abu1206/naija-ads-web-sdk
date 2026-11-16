/** Inline audio card with a required, layout-stable companion creative. */
import type { AdDeps } from './base';
import { BaseAd } from './base';
import { NaijaAdsError } from './errors';
import { createSurface, el, parseSize, waitForPaint } from './render';

export interface AudioOptions {
  container?: HTMLElement;
  testAudioDurationMs?: number;
}

const DEFAULT_TEST_DURATION_MS = 5000;
const MIN_TEST_DURATION_MS = 10;
const MAX_TEST_DURATION_MS = 60_000;
const TICK_MS = 50;

export class AudioAd extends BaseAd {
  private readonly testAudioDurationMs: number;
  private host: HTMLElement | null = null;
  private audio: HTMLAudioElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedSent = false;
  private completedSent = false;
  private shown = false;

  constructor(deps: AdDeps, placementId: string, options: AudioOptions = {}) {
    super(deps, placementId);
    const configured = options.testAudioDurationMs ?? DEFAULT_TEST_DURATION_MS;
    const requested = Number.isFinite(configured) ? configured : DEFAULT_TEST_DURATION_MS;
    this.testAudioDurationMs = Math.min(MAX_TEST_DURATION_MS, Math.max(MIN_TEST_DURATION_MS, requested));
  }

  async show(container: HTMLElement): Promise<void> {
    if (this.destroyed) throw new NaijaAdsError('destroyed', 'This audio ad was destroyed. Load a new one.');
    this.assertFresh();
    if (this.shown) throw new NaijaAdsError('invalid_config', 'This audio response was already shown. Load a new one.');
    this.shown = true;

    const surface = createSurface('inline', 'audio');
    try {
      const card = el('div', 'naija-audio');
      card.setAttribute('aria-label', this.test ? 'Test sponsored audio' : 'Sponsored audio');
      const companion = this.buildCompanion();
      card.append(companion.node, this.test ? this.buildTestControls() : this.buildLiveControls());
      surface.root.appendChild(card);
      this.host?.remove();
      this.host = surface.host;
      container.appendChild(surface.host);
      await waitForPaint(companion.paintTarget);
      await this.sendImpression();
      this.startViewability(
        surface.host,
        'image',
        undefined,
        () => this.audio ? !this.audio.paused && !this.audio.muted && this.audio.volume > 0 : false,
      );
    } catch (err) {
      this.abandonImpression();
      surface.host.remove();
      if (this.host === surface.host) this.host = null;
      throw err;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.finishViewability();
    this.abandonImpression();
    this.destroyed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.audio?.pause();
    this.audio = null;
    this.host?.remove();
    this.host = null;
    this.onDestroy?.();
  }

  private buildCompanion(): { node: HTMLElement; paintTarget: HTMLElement } {
    if (this.test) {
      const click = el('button', 'naija-click naija-test naija-test-strip');
      click.type = 'button';
      click.setAttribute('aria-label', 'Test sponsored link');
      const label = el('p', 'naija-test-sub');
      label.textContent = 'Test companion banner · Naija Ads';
      click.appendChild(label);
      click.addEventListener('click', () => this.handleClick());
      return { node: click, paintTarget: click };
    }
    if (!this.creative || this.creative.kind !== 'audio' || !this.creative.companionUrl) {
      throw new NaijaAdsError('unknown_error', 'Live audio fill did not include audio and its required companion banner.');
    }
    const dims = parseSize(this.creative.companionSize ?? null);
    if (!dims) throw new NaijaAdsError('unknown_error', 'Audio companion did not include a valid logical size.');

    const frame = el('div', 'naija-frame');
    frame.style.width = `${dims.width}px`;
    frame.style.aspectRatio = `${dims.width} / ${dims.height}`;
    const img = document.createElement('img');
    img.className = 'naija-companion';
    img.src = this.creative.companionUrl;
    img.alt = 'Sponsored';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    if (this.clickUrl) {
      const click = el('button', 'naija-click');
      click.type = 'button';
      click.setAttribute('aria-label', 'Open sponsored link');
      click.appendChild(img);
      click.addEventListener('click', () => this.handleClick());
      frame.appendChild(click);
    } else {
      frame.appendChild(img);
    }
    const badge = el('span', 'naija-badge');
    badge.textContent = 'Sponsored';
    frame.appendChild(badge);
    return { node: frame, paintTarget: img };
  }

  private buildLiveControls(): HTMLElement {
    if (!this.creative) throw new NaijaAdsError('unknown_error', 'Live fill did not include a creative.');
    const row = el('div', 'naija-audio-row');
    const button = el('button', 'naija-audio-btn');
    button.type = 'button';
    button.setAttribute('aria-label', 'Play sponsored audio');
    button.textContent = '▶';

    const audio = document.createElement('audio');
    audio.src = this.creative.url;
    audio.preload = 'metadata';
    audio.style.display = 'none';
    this.audio = audio;

    const bar = el('div', 'naija-progress');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Sponsored audio progress');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', '0');
    const fill = el('div', 'naija-progress-fill');
    bar.appendChild(fill);

    const durationMs = this.creative.durationMs ?? 0;
    audio.addEventListener('playing', () => {
      button.textContent = '⏸';
      button.setAttribute('aria-label', 'Pause sponsored audio');
      this.viewabilityStateChanged();
      if (this.startedSent) return;
      this.startedSent = true;
      void this.sendOrderedEvent('audio_started');
    });
    audio.addEventListener('pause', () => {
      button.textContent = '▶';
      button.setAttribute('aria-label', 'Play sponsored audio');
      this.viewabilityStateChanged();
    });
    audio.addEventListener('ended', () => {
      button.textContent = '▶';
      button.setAttribute('aria-label', 'Play sponsored audio');
      fill.style.width = '100%';
      bar.setAttribute('aria-valuenow', '100');
      this.viewabilityStateChanged();
      if (this.completedSent) return;
      this.completedSent = true;
      void this.sendOrderedEvent('audio_completed');
      this.emit('completed');
    });
    audio.addEventListener('timeupdate', () => {
      if (durationMs <= 0) return;
      const progress = Math.min(100, (audio.currentTime * 1000 / durationMs) * 100);
      fill.style.width = `${progress}%`;
      bar.setAttribute('aria-valuenow', `${Math.round(progress)}`);
    });
    audio.addEventListener('error', () => this.emit('error', new NaijaAdsError('creative_failed', 'Sponsored audio failed to load or play.')));
    button.addEventListener('click', () => {
      if (audio.paused) {
        void audio.play().catch((cause: unknown) => {
          this.emit('error', new NaijaAdsError('creative_failed', 'Sponsored audio could not start.', { cause }));
        });
      } else audio.pause();
    });
    row.append(button, bar, audio);
    return row;
  }

  private buildTestControls(): HTMLElement {
    const row = el('div', 'naija-audio-row');
    const button = el('button', 'naija-audio-btn');
    button.type = 'button';
    button.setAttribute('aria-label', 'Play test ad');
    button.textContent = '▶';
    const bar = el('div', 'naija-progress');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Test audio progress');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', '0');
    const fill = el('div', 'naija-progress-fill');
    bar.appendChild(fill);

    let playing = false;
    let elapsed = 0;
    button.addEventListener('click', () => {
      if (playing) {
        playing = false;
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        button.textContent = '▶';
        button.setAttribute('aria-label', 'Play test ad');
        return;
      }
      playing = true;
      button.textContent = '⏸';
      button.setAttribute('aria-label', 'Pause test ad');
      if (!this.startedSent) {
        this.startedSent = true;
        void this.sendOrderedEvent('audio_started');
      }
      if (this.timer !== null) return;
      this.timer = setInterval(() => {
        elapsed += TICK_MS;
        const progress = Math.min(100, (elapsed / this.testAudioDurationMs) * 100);
        fill.style.width = `${progress}%`;
        bar.setAttribute('aria-valuenow', `${Math.round(progress)}`);
        if (elapsed >= this.testAudioDurationMs) {
          playing = false;
          if (this.timer !== null) clearInterval(this.timer);
          this.timer = null;
          button.textContent = '▶';
          button.setAttribute('aria-label', 'Play test ad');
          if (!this.completedSent) {
            this.completedSent = true;
            void this.sendOrderedEvent('audio_completed');
            this.emit('completed');
          }
        }
      }, TICK_MS);
    });
    row.append(button, bar);
    return row;
  }
}
