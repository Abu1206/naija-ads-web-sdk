/** Lightweight OMID-shaped observation plumbing (backend ADR 0018/0022). */
export interface ViewabilityObservation {
  visibleFractionBps: number;
  continuousVisibleMs: number;
  audible?: boolean;
}

export interface ViewabilityOptions {
  target: HTMLElement;
  thresholdMs: number;
  active?: () => boolean;
  audible?: () => boolean | undefined;
  report: (observation: ViewabilityObservation) => void;
}

const SAMPLE_MS = 200;

export class ViewabilityTracker {
  private ratio = 0;
  private maxRatio = 0;
  private visibleSince: number | null = null;
  private maxContinuousMs = 0;
  private reported = false;
  private observer: IntersectionObserver | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly active: () => boolean;
  private readonly audible: () => boolean | undefined;

  constructor(private readonly options: ViewabilityOptions) {
    this.active = options.active ?? (() => true);
    this.audible = options.audible ?? (() => undefined);
  }

  start(): void {
    if (this.timer !== null || this.reported) return;
    if (typeof IntersectionObserver === 'function') {
      this.observer = new IntersectionObserver((entries) => {
        const entry = entries[0];
        this.ratio = entry?.isIntersecting ? Math.max(0, Math.min(1, entry.intersectionRatio)) : 0;
        this.maxRatio = Math.max(this.maxRatio, this.ratio);
        this.sample();
      }, { threshold: [0, 0.5, 1] });
      this.observer.observe(this.options.target);
    } else {
      // No geometry observer means unverifiable, never optimistically viewable.
      this.ratio = 0;
      this.maxRatio = 0;
    }
    document.addEventListener('visibilitychange', this.sample);
    window.addEventListener('pagehide', this.pageHide);
    this.timer = setInterval(this.sample, SAMPLE_MS);
    this.sample();
  }

  /** Call after play/pause so continuous video time never includes a pause. */
  stateChanged(): void {
    this.sample();
  }

  finish(): void {
    this.sample();
    if (!this.reported) this.send();
    this.stop();
  }

  private readonly sample = (): void => {
    if (this.reported) return;
    const now = performance.now();
    const qualifies = document.visibilityState === 'visible' && this.ratio >= 0.5 && this.active();
    if (qualifies) {
      if (this.visibleSince === null) this.visibleSince = now;
      this.maxContinuousMs = Math.max(this.maxContinuousMs, now - this.visibleSince);
      if (this.maxContinuousMs >= this.options.thresholdMs) this.send();
    } else if (this.visibleSince !== null) {
      this.maxContinuousMs = Math.max(this.maxContinuousMs, now - this.visibleSince);
      this.visibleSince = null;
    }
  };

  private readonly pageHide = (): void => {
    if (!this.reported) this.send();
  };

  private send(): void {
    if (this.reported) return;
    this.reported = true;
    this.options.report({
      visibleFractionBps: Math.round(this.maxRatio * 10_000),
      continuousVisibleMs: Math.min(3_600_000, Math.max(0, Math.round(this.maxContinuousMs))),
      audible: this.audible(),
    });
    this.stop();
  }

  private stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    document.removeEventListener('visibilitychange', this.sample);
    window.removeEventListener('pagehide', this.pageHide);
    this.visibleSince = null;
  }
}
