/**
 * DOM helpers: one injected stylesheet, paint detection for render
 * attestation (ADR 0010), size parsing and safe click-through.
 * No framework, no dependencies — the SDK must stay tiny for games.
 */

const STYLE_ID = 'naija-ads-sdk-styles';

const CSS = `
.naija-ads-slot{position:relative}
.naija-ads-banner{position:relative;display:inline-block;overflow:hidden;cursor:pointer;max-width:100%}
.naija-ads-banner img{display:block;max-width:100%;height:auto}
.naija-ads-overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center}
.naija-ads-close{position:absolute;top:12px;right:12px;z-index:2;width:36px;height:36px;border:0;border-radius:50%;background:rgba(255,255,255,.92);color:#111;font-size:18px;line-height:36px;cursor:pointer;padding:0}
.naija-ads-close:disabled{opacity:.4;cursor:default}
.naija-ads-media{max-width:96vw;max-height:92vh;display:block}
.naija-ads-test{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;background:linear-gradient(135deg,#0a7d33,#12b34a);color:#fff;font-family:system-ui,-apple-system,sans-serif;text-align:center;border-radius:6px;box-sizing:border-box}
.naija-ads-test-title{font-weight:700;font-size:14px;margin:0}
.naija-ads-test-sub{font-size:11px;opacity:.85;margin:0}
.naija-ads-test-full{width:min(92vw,480px);height:min(72vh,640px)}
.naija-ads-progress{position:relative;width:70%;height:8px;background:rgba(255,255,255,.3);border-radius:4px;overflow:hidden}
.naija-ads-progress-fill{position:absolute;inset:0;width:0%;background:#fff;transition:width .1s linear}
`;

/** Injects the SDK stylesheet exactly once. */
export function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cap for waiting on media paint before attesting anyway. Real browsers fire
 * load/decode events quickly; the timeout exists for pathological cases and
 * for DOM-less test environments. Tests may shorten it.
 */
let paintTimeoutMs = 3000;

/** Test-only hook (not exported from the bundle entry): shortens the paint wait. */
export function setPaintTimeoutForTests(ms: number): void {
  paintTimeoutMs = ms;
}

function animationFrame(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  // jsdom and very old browsers: a macrotask tick is close enough.
  return delay(16);
}

/**
 * Resolves when `el` actually painted: media decoded/first frame + two
 * animation frames. Falls back after `timeoutMs` so a hung media element can
 * never stall the impression forever.
 */
export async function waitForPaint(el: HTMLElement, timeoutMs = paintTimeoutMs): Promise<void> {
  const painted = (async () => {
    if (el instanceof HTMLImageElement) {
      if (!el.complete) {
        await new Promise<void>((resolve) => {
          el.addEventListener('load', () => resolve(), { once: true });
          el.addEventListener('error', () => resolve(), { once: true });
        });
      }
    } else if (el instanceof HTMLVideoElement && el.readyState < 2) {
      await new Promise<void>((resolve) => {
        el.addEventListener('loadeddata', () => resolve(), { once: true });
        el.addEventListener('playing', () => resolve(), { once: true });
        el.addEventListener('error', () => resolve(), { once: true });
      });
    }
  })();
  await Promise.race([painted, delay(timeoutMs)]);
  await animationFrame();
  await animationFrame();
}

/** Parses "WxH" banner sizes ("320x50"). Returns null when malformed. */
export function parseSize(size: string | null): { width: number; height: number } | null {
  if (!size) return null;
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return null;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Adaptive slots (ADR 0012): report the slot's width in CSS px. Clamped to
 * the server's 1..4096 range; undefined when unmeasurable (server then uses
 * the placement's first preference).
 */
export function measureWidthDp(el?: HTMLElement | null, override?: number): number | undefined {
  const raw = override ?? (el ? el.getBoundingClientRect().width : undefined);
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(4096, Math.max(1, Math.round(raw)));
}

/** Opens the served click_url in a new tab; falls back to same-tab navigation. */
export function openClickUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return; // server only sends http(s); belt and suspenders
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (!win) window.location.href = url; // popup blocker fallback (still a user gesture)
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
