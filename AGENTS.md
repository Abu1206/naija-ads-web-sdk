# AGENTS.md — naija-ads-web-sdk

> Instructions for AI agents AND human contributors building the Naija Ads Web SDK.
> Contract source of truth: the Go backend (`naija-ads-backend`, `internal/ads` + ADRs 0004/0010/0012/0014/0019).
> This file tells you HOW to build the SDK. Do not drift without an ADR in this repo.

## 1. What this is

The **web-first SDK** (backend ADR 0005) that game/app developers embed to monetize inventory:
`NaijaAds.initialize` → `loadBanner / loadInterstitial / loadRewarded` → render → attest → report.

Four MVP formats, banner first-class: **banner (fixed + adaptive), interstitial, rewarded, audio**
(audio carries a required companion banner; completion is analytics-only — backend ADR 0019, this repo's [`docs/adr/0002`](./docs/adr/0002-audio-ads.md)).

## 2. Tech rules (do not change without RFC)

- **TypeScript strict, zero runtime dependencies.** `npm ls --prod` must list nothing. The SDK ships into other people's games; every byte and dep is a tax on them.
- Two artifacts via tsup: `dist/index.js` (ESM for bundlers) and `dist/index.global.js` (IIFE exposing `window.NaijaAds` for plain `<script>`). Both minified, with d.ts.
- Tests: **Vitest + jsdom**, colocated `src/*.test.ts`. No browser-only CI flakiness: jsdom + fetch mocks only.
- No build-time bundling of CSS frameworks, no React/Vue adapters in core (wrappers can live in separate packages later).

## 3. Backend contract (mirror — never redefine)

Base URL is developer-provided. Two SDK endpoints (CORS `*`, no credentials, JSON only):

| Call | Body (wire, snake_case) | Success |
| ---- | ----------------------- | ------- |
| `POST /v1/ads/request` | `app_id, placement_id, ad_type, session_id, mode, context{slot_width_dp?, device_type?}` | `{fill, test, reason?, impression_id?, banner_size?, expires_in?, creative?, click_url?, render_token?}` |
| `POST /v1/ads/events` | `event_id, event_type, impression_id, placement_id, session_id, mode, render_token?, client_ts?` | 202 `{accepted, duplicate, reward?}` |

`event_type` ∈ `impression | click | video_started | video_completed | audio_started | audio_completed`.
Errors: `{"error": {"code", "message", ...}}` — codes mapped 1:1 into `NaijaAdsError.code`.
Field renames or new endpoints = **cross-repo RFC + linked backend PR** (CONTRIBUTING.md §3).

## 4. CRITICAL invariants (violations = reject PR)

1. **Server decides everything.** No client pricing, auction, targeting, or reward logic. Ever.
2. **`APP_ID` is the only public identifier.** SDK secrets never exist in this repo, the bundle, or docs examples.
3. **Impression is attested after paint.** The impression event waits for media decode/first-frame + rAF, and carries the server-issued `render_token` (ADR 0010). Never attest on request success alone.
4. **Ordering.** Impression before click/video events; server rejects out-of-order — the SDK enforces it too (no click events before the impression was accepted).
5. **Open the served `click_url` exactly.** Never build, wrap, or redirect through a client-computed URL (ADR 0019).
6. **Same `event_id` on retries.** Transient failures retry with the identical id (server dedupes); a new id can double-count.
7. **Rewards are server decisions.** `show()` resolves with the server's confirmed/rejected outcome; the `reward_token` goes to the developer's **game server**, which verifies it via `POST /v1/rewards/verify` (Bearer secret, server-to-server). The browser can never grant a reward.
8. **Test mode renders built-in test creatives.** The test response carries no creative; the SDK draws clearly labelled placeholders and runs the identical event flow (`mode: "test"`). Nothing may differ between modes except what the server returns.
9. **Diagnostics over silence (RISKS.md R10).** Every rejection maps to a code + fix-it hint. A broken integration must never read as a mystery no-fill.
10. **Minimization (ADR 0016).** No IP handling, no fingerprints, no extra identifiers beyond `session_id` (per page session, sessionStorage); `client_ts` off by default; `referrerPolicy="no-referrer"` on creatives.

## 5. Module map

```
src/
├── index.ts          # public API: initialize, load*, destroyAll, re-exports
├── client.ts         # ApiClient: request/event POSTs, retries, error mapping
├── types.ts          # wire (snake_case, mirrors Go) + public (camelCase) types
├── errors.ts         # NaijaAdsError + per-code fix-it hints (R10)
├── base.ts           # BaseAd: impression lifecycle, render token, click flow
├── render.ts         # stylesheet, paint detection (ADR 0010), sizes, click-through
├── banner.ts         # fixed + adaptive (slot_width_dp), refresh ≥ 15s
├── interstitial.ts   # full-screen image/video; video progress analytics-only
├── rewarded.ts       # gated player; server-decided outcome; test-mode simulator
├── audio.ts          # inline card player; required companion banner; analytics-only
├── session.ts        # per-page-session session_id (sessionStorage)
└── uuid.ts           # event/session ids
```

## 6. TESTING — required, not optional

Every PR includes/extends tests; CI (`typecheck`, `build`, `vitest run`) must be green.

| Area | Must be covered |
| ---- | --------------- |
| `client` | wire→public mapping; no-fill is a response not an error; error codes + hints; Retry-After → `retryAfterMs`; **retries reuse the same `event_id`**; gives up after 3 attempts; network → `network` |
| `session` | persisted per session; reset; oversized stored ids replaced |
| `banner` | test-mode placeholder + attested impression (no token); live img render + `render_token`; click opens served `click_url` + click event; no-fill rejection; refresh re-requests (new impression); refresh < 15s rejected |
| `interstitial` | overlay + dismiss; live video `video_started`/`video_completed` ordering |
| `rewarded` | test-mode full flow (started → completed → confirmed, no token); live confirmed (token) / rejected (reason); **dismiss before completion claims nothing**; video error; autoplay-blocked unlock |
| `audio` | test-mode card + started → completed; live companion banner render + render token; playback events; **pause before end claims no completion**; destroy mid-play cancels the simulator; no-fill rejection |
| `index` | config validation; `mode` defaults to `test`; re-initialize tears down; `destroyAll` |

Conventions: fake `fetch` via `vi.stubGlobal`; `setPaintTimeoutForTests` shortens paint waits in jsdom; never assert on wall-clock; every bug fix ships a failing-first regression test.

```bash
npm run typecheck   # tsc --noEmit (must pass)
npm test            # vitest run (must pass)
npm run build       # tsup, must emit ESM + IIFE + d.ts
```

## 7. What NOT to build (backend spec §27 + scope discipline)

No React/Vue wrappers in core, no ad caching beyond the server's `expires_in`, no header bidding, no viewability libraries, no consent/IDFA-style machinery (backend ADR 0016 — there is nothing to gate), no ML anything, no secondary adapters (Amazon/AdSense mediation). **Reject scope creep PRs.**

## 8. Versioning + compatibility

Semver. The SDK is coupled to the backend contract: a release notes the backend tag it was verified against (see README compatibility table). Breaking wire changes ⇒ major bump + backend release note. `VERSION` in `src/version.ts` is the single source; keep it in sync with `package.json`.

## 9. Working agreements (details in CONTRIBUTING.md + docs/COLLABORATION.md)

Branches `feat/<issue>-<slug>`, Conventional Commits, small PRs (<400 lines) with test evidence, 1 approval, CI green, squash-merge. Contract changes need the backend PR linked in the description.
