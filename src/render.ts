/**
 * Isolated rendering primitives shared by all formats (ADR 0003).
 * Every ad owns a closed ShadowRoot: publisher CSS cannot resize an inner
 * close control or remove attribution, while the publisher still owns where
 * the host slot sits in its page.
 */
import { NaijaAdsError } from './errors';
import type { BannerLayout, DeviceType } from './types';

const CSS = `
:host{all:initial;box-sizing:border-box;color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
:host([data-display="inline"]){display:block;position:relative;width:100%;line-height:normal;contain:layout style paint}
:host([data-display="overlay"]){display:block;position:fixed;inset:0;width:100vw;height:100vh;height:100dvh;z-index:2147483647;line-height:normal}
*{box-sizing:border-box}
button{font:inherit}
button:focus-visible{outline:3px solid #fff;outline-offset:3px}
.naija-frame{position:relative;display:grid;place-items:center;overflow:hidden;margin-inline:auto;max-width:100%;background:#fff}
.naija-click{display:block;position:relative;width:100%;height:100%;margin:0;padding:0;border:0;background:transparent;color:inherit;cursor:pointer}
.naija-banner-img,.naija-companion{display:block;width:100%;height:100%;object-fit:contain}
.naija-badge{position:absolute;top:4px;left:4px;z-index:3;padding:3px 5px;border-radius:3px;background:rgba(0,0,0,.72);color:#fff;font:700 10px/1 system-ui,sans-serif;letter-spacing:.02em;pointer-events:none}
.naija-overlay{position:absolute;inset:0;display:grid;place-items:center;overflow:hidden;background:#000;color:#fff}
.naija-media-shell{position:absolute;inset:0;display:grid;place-items:center;padding:max(12px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left))}
.naija-media{display:block;width:100%;height:100%;min-width:0;min-height:0;object-fit:contain;background:#000}
.naija-close,.naija-sound,.naija-play{position:absolute;z-index:4;min-width:44px;min-height:44px;border:0;border-radius:999px;background:rgba(255,255,255,.96);color:#111;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.28)}
.naija-close{top:max(12px,env(safe-area-inset-top));right:max(12px,env(safe-area-inset-right));width:44px;height:44px;padding:0;font-size:24px;line-height:1}
.naija-sound{right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));padding:0 14px;font-size:13px;font-weight:700}
.naija-play{inset:50% auto auto 50%;transform:translate(-50%,-50%);padding:0 18px;font-size:14px;font-weight:700}
.naija-audio{display:flex;flex-direction:column;gap:10px;width:min(100%,420px);margin-inline:auto;padding:10px;border:1px solid #d9dde0;border-radius:10px;background:#fff;color:#111}
.naija-audio-row{display:flex;align-items:center;gap:10px}
.naija-audio-btn{flex:0 0 auto;width:44px;height:44px;border:0;border-radius:50%;background:#0a7d33;color:#fff;font-size:15px;cursor:pointer;padding:0}
.naija-audio-btn:focus-visible{outline-color:#0a7d33}
.naija-progress{position:relative;flex:1 1 auto;height:8px;background:rgba(0,0,0,.15);border-radius:999px;overflow:hidden}
.naija-overlay .naija-progress{position:absolute;left:max(16px,env(safe-area-inset-left));right:max(16px,env(safe-area-inset-right));bottom:max(20px,env(safe-area-inset-bottom));z-index:3;background:rgba(255,255,255,.32)}
.naija-progress-fill{position:absolute;inset:0;width:0%;background:#0a7d33;transition:width .1s linear}
.naija-overlay .naija-progress-fill{background:#fff}
.naija-test{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;width:100%;height:100%;background:linear-gradient(135deg,#075f29,#0c9a42);color:#fff;text-align:center}
.naija-test-title{font-weight:800;font-size:14px;margin:0}
.naija-test-sub{font-size:11px;opacity:.9;margin:0}
.naija-test-full{width:min(100%,480px);height:min(100%,640px);border-radius:10px}
.naija-test-strip{min-height:50px;padding:10px;border-radius:6px}
@media (prefers-reduced-motion:reduce){.naija-progress-fill{transition:none}}
`;

type DisplayKind = 'inline' | 'overlay';

const testRoots = new WeakMap<HTMLElement, ShadowRoot>();

export interface Surface {
  host: HTMLElement;
  root: ShadowRoot;
}

export function createSurface(display: DisplayKind, format: string): Surface {
  const host = document.createElement('div');
  host.dataset.naijaAds = format;
  host.dataset.display = display;
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);
  testRoots.set(host, root);
  return { host, root };
}

/** Test-only hook (not exported from the package entry). */
export function getRenderRootForTests(host: HTMLElement): ShadowRoot | undefined {
  return testRoots.get(host);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let paintTimeoutMs = 15_000;
let geometryChecks = true;

/** Test-only hooks (not exported from the package entry). */
export function setPaintTimeoutForTests(ms: number): void {
  paintTimeoutMs = ms;
}

export function setGeometryChecksForTests(value: boolean): void {
  geometryChecks = value;
}

function animationFrame(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return delay(16);
}

async function mediaReady(el: HTMLElement): Promise<void> {
  if (el instanceof HTMLImageElement) {
    if (!el.complete) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          el.removeEventListener('load', loaded);
          el.removeEventListener('error', failed);
        };
        const loaded = (): void => { cleanup(); resolve(); };
        const failed = (): void => { cleanup(); reject(new Error('image load failed')); };
        el.addEventListener('load', loaded);
        el.addEventListener('error', failed);
      });
    }
    if (geometryChecks && el.naturalWidth <= 0) throw new Error('image decode failed');
    if (typeof el.decode === 'function') await el.decode();
    return;
  }
  if (el instanceof HTMLVideoElement) {
    if (el.readyState >= 2) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        el.removeEventListener('loadeddata', ready);
        el.removeEventListener('playing', ready);
        el.removeEventListener('error', failed);
      };
      const ready = (): void => { cleanup(); resolve(); };
      const failed = (): void => { cleanup(); reject(new Error('video load failed')); };
      el.addEventListener('loadeddata', ready);
      el.addEventListener('playing', ready);
      el.addEventListener('error', failed);
    });
    return;
  }
}

function renderedGeometry(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  let current: HTMLElement | null = el;
  while (current) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) {
      return false;
    }
    const root = current.getRootNode();
    current = current.parentElement ?? (root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null);
  }
  return true;
}

/**
 * Resolves only after decode/first frame, connected non-zero geometry and two
 * animation frames. Error or timeout rejects: a broken/hidden creative must
 * never be attested as painted.
 */
export async function waitForPaint(el: HTMLElement, timeoutMs = paintTimeoutMs): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('paint timeout')), timeoutMs);
      void mediaReady(el).then(resolve, reject);
    }).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    await animationFrame();
    await animationFrame();
    while (geometryChecks && !renderedGeometry(el)) {
      if (Date.now() >= deadline) throw new Error('creative has no rendered geometry');
      await animationFrame();
    }
  } catch (cause) {
    throw new NaijaAdsError('creative_failed', 'The creative failed before it painted; no impression was sent.', { cause });
  }
}

/** Parses a logical "WxH" size. */
export function parseSize(size: string | null): { width: number; height: number } | null {
  if (!size) return null;
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return null;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function clampDimension(raw: number | undefined): number | undefined {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(4096, Math.max(1, Math.round(raw)));
}

export function measureWidthDp(el?: HTMLElement | null, override?: number): number | undefined {
  return clampDimension(override ?? (el ? el.getBoundingClientRect().width : undefined));
}

export function measureHeightDp(el?: HTMLElement | null, override?: number): number | undefined {
  return clampDimension(override ?? (el ? el.getBoundingClientRect().height : undefined));
}

/** Google-style large anchored ceiling: 20% of visible height, max 150 CSS px. */
export function anchoredMaxHeightDp(): number | undefined {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  return clampDimension(Math.min(150, Math.floor(viewportHeight * 0.2)));
}

export function slotHeightDp(layout?: BannerLayout, container?: HTMLElement | null, override?: number): number | undefined {
  if (override !== undefined) return clampDimension(override);
  if (layout === 'anchored') return anchoredMaxHeightDp();
  // An explicitly reserved inline container may provide a real ceiling. A 0px
  // pre-load container is intentionally omitted rather than causing no-fill.
  return measureHeightDp(container);
}

export function detectDeviceType(): DeviceType {
  const width = window.visualViewport?.width ?? window.innerWidth;
  if (width <= 600) return 'phone';
  if (width <= 1024) return 'tablet';
  return 'desktop';
}

/** Opens exactly the served URL; navigation remains in the user's gesture. */
export function openClickUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (!win) window.location.href = url;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

interface InertState { node: HTMLElement; inert: boolean }

/** Makes a Shadow-DOM overlay a real modal and restores the host page exactly. */
export function activateModal(surface: Surface, initialFocus: HTMLElement, onEscape: () => void): () => void {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const previousOverflow = document.body.style.overflow;
  const inertStates: InertState[] = [];
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement) || child === surface.host) continue;
    inertStates.push({ node: child, inert: child.inert });
    child.inert = true;
  }
  document.body.style.overflow = 'hidden';

  const keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(surface.root.querySelectorAll<HTMLElement>(
      'button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
    )).filter((node) => !node.hidden);
    if (focusable.length === 0) return;
    const current = surface.root.activeElement;
    const index = focusable.indexOf(current as HTMLElement);
    const next = event.shiftKey
      ? focusable[(index <= 0 ? focusable.length : index) - 1]
      : focusable[(index + 1) % focusable.length];
    event.preventDefault();
    next?.focus();
  };
  window.addEventListener('keydown', keydown);
  initialFocus.focus();

  return () => {
    window.removeEventListener('keydown', keydown);
    document.body.style.overflow = previousOverflow;
    for (const state of inertStates) state.node.inert = state.inert;
    if (previousFocus?.isConnected) previousFocus.focus();
  };
}
