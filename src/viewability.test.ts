import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewabilityTracker } from './viewability';

type ObserverCallback = (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void;

describe('ViewabilityTracker', () => {
  let callback: ObserverCallback;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(next: ObserverCallback) { callback = next; }
      observe(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('reports the raw display observation after 50% continuous visibility for one second', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const report = vi.fn();
    const tracker = new ViewabilityTracker({ target, thresholdMs: 1_000, report });
    tracker.start();
    callback([{ isIntersecting: true, intersectionRatio: 0.6 }]);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatchObject({ visibleFractionBps: 6_000 });
    expect(report.mock.calls[0]?.[0].continuousVisibleMs).toBeGreaterThanOrEqual(1_000);
  });

  it('counts video visibility only while playback is active', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    let active = false;
    const report = vi.fn();
    const tracker = new ViewabilityTracker({ target, thresholdMs: 2_000, active: () => active, report });
    tracker.start();
    callback([{ isIntersecting: true, intersectionRatio: 1 }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(report).not.toHaveBeenCalled();

    active = true;
    tracker.stateChanged();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('reports a bounded non-viewable observation on teardown', () => {
    const target = document.createElement('div');
    const report = vi.fn();
    const tracker = new ViewabilityTracker({ target, thresholdMs: 1_000, report });
    tracker.start();
    callback([{ isIntersecting: false, intersectionRatio: 0 }]);
    tracker.finish();
    expect(report).toHaveBeenCalledWith({ visibleFractionBps: 0, continuousVisibleMs: 0, audible: undefined });
  });
});
