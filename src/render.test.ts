import { afterEach, describe, expect, it } from 'vitest';
import {
  createSurface,
  getRenderRootForTests,
  measureHeightDp,
  measureWidthDp,
  parseSize,
  setGeometryChecksForTests,
  setPaintTimeoutForTests,
  waitForPaint,
} from './render';

describe('responsive rendering primitives', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    setGeometryChecksForTests(true);
    setPaintTimeoutForTests(15_000);
  });

  it('keeps canonical logical dimensions and clamps reported geometry', () => {
    expect(parseSize('728x90')).toEqual({ width: 728, height: 90 });
    expect(parseSize('bad')).toBeNull();
    const slot = document.createElement('div');
    slot.getBoundingClientRect = () => ({ width: 767.6, height: 89.6, x: 0, y: 0, top: 0, left: 0, right: 767.6, bottom: 89.6, toJSON: () => ({}) });
    expect(measureWidthDp(slot)).toBe(768);
    expect(measureHeightDp(slot)).toBe(90);
    expect(measureWidthDp(slot, 9000)).toBe(4096);
  });

  it('isolates styles and includes dynamic viewport, containment, safe-area and 44px controls', () => {
    const surface = createSurface('overlay', 'rewarded');
    document.body.appendChild(surface.host);
    expect(surface.host.shadowRoot).toBeNull();
    expect(getRenderRootForTests(surface.host)).toBe(surface.root);
    const css = surface.root.querySelector('style')?.textContent ?? '';
    expect(css).toContain('height:100dvh');
    expect(css).toContain('object-fit:contain');
    expect(css).toContain('env(safe-area-inset-top)');
    expect(css).toContain('min-width:44px');
  });

  it('rejects a failed image instead of attesting it after a timeout', async () => {
    setGeometryChecksForTests(true);
    setPaintTimeoutForTests(100);
    const image = document.createElement('img');
    document.body.appendChild(image);
    const pending = waitForPaint(image);
    image.dispatchEvent(new Event('error'));
    await expect(pending).rejects.toMatchObject({ code: 'creative_failed' });
  });
});
