# naija-ads-web-sdk

Web SDK for **Naija Ads** — banner, interstitial and rewarded ads for web games and apps.

Build rules: [`AGENTS.md`](./AGENTS.md) · Team workflow: [`CONTRIBUTING.md`](./CONTRIBUTING.md) + [`docs/COLLABORATION.md`](./docs/COLLABORATION.md) · Decisions: [`docs/adr/`](./docs/adr/)

- **Zero dependencies**, ~20 KB minified, TypeScript strict, ESM + `<script>` bundle.
- Test mode renders built-in placeholder ads and exercises the identical event flow (`ADR 0004`).
- Rewards are **server-decided**: the SDK hands you a `reward_token`; your backend verifies it.

## Install

```bash
npm install naija-ads-web-sdk
```

or drop the script tag:

```html
<script src="https://cdn.example.com/naija-ads/v0/index.global.js"></script>
```

## Quickstart

```ts
import { initialize } from 'naija-ads-web-sdk';

const ads = initialize({
  appId: 'YOUR_APP_ID',          // public — never a secret
  baseUrl: 'https://api.naijaads.example',
  mode: 'test',                  // default; 'live' needs an approved app
});

// Banner (adaptive: the SDK reports the container width, ADR 0012)
const banner = await ads.loadBanner('BANNER_PLACEMENT_ID', {
  container: document.getElementById('slot'),
  refreshIntervalMs: 30_000,     // optional, ≥ 15s
});
banner.on('impression', () => console.log('attested'));
banner.on('error', (e) => console.warn(e.code, e.message));

// Interstitial
const inter = await ads.loadInterstitial('INTERSTITIAL_PLACEMENT_ID');
await inter.show();              // full-screen overlay; 'dismissed' event on close

// Rewarded — the server decides, the SDK reports
const rewarded = await ads.loadRewarded('REWARDED_PLACEMENT_ID');
const outcome = await rewarded.show();
if (outcome.status === 'confirmed') {
  // ⚠️ Send outcome.rewardToken to YOUR backend, which must verify it:
  //    POST /v1/rewards/verify  (Authorization: Bearer <SDK secret>, server-to-server only)
  //    { valid, first_redemption } — grant only when both are true (ADR 0010).
  grantExtraLife();
}
```

Game-server verification example (Node):

```js
// NEVER embed the SDK secret in the browser. This runs on your server.
const res = await fetch(baseUrl + '/v1/rewards/verify', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.NAIJA_SDK_SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ reward_token: outcome.rewardToken }),
});
const { valid, first_redemption } = await res.json();
if (valid && first_redemption) grantReward(); // replays return first_redemption=false
```

## Compatibility

| SDK | Backend contract | Notes |
| --- | ---------------- | ----- |
| 0.1.x | naija-ads-backend `main` @ 2026-10 (ADRs 0004, 0010, 0012, 0014, 0019) | banner/interstitial/rewarded + test mode |

## API

| Member | Returns | Notes |
| ------ | ------- | ----- |
| `initialize({ appId, baseUrl, mode? })` | `NaijaAds` | validates config; re-init destroys previous ads |
| `loadBanner(placementId, { container?, widthDp?, refreshIntervalMs? })` | `Promise<BannerAd>` | rejects `no_fill` with server `reason` |
| `loadInterstitial(placementId)` | `Promise<InterstitialAd>` | `show()` renders a full-screen overlay |
| `loadRewarded(placementId, { testVideoDurationMs? })` | `Promise<RewardedAd>` | `show()` → `Promise<RewardOutcome>` |
| `destroyAll()` | `void` | stops timers, removes overlays |

Events on every ad: `impression`, `click`, `error` (+ `dismissed`, `rewarded` where relevant).
Errors are `NaijaAdsError` with `code`, `reason?`, `retryAfterMs?` and a fix-it hint in `message`.

## Demo

```bash
npm run build
# serve demo/index.html, point baseUrl at your local backend (go run ./cmd/api)
```

## Development

```bash
npm install
npm run typecheck   # must pass
npm test            # vitest + jsdom, must pass
npm run build       # ESM + IIFE + d.ts into dist/
```

Status: 🚧 foundation (Phase 2). Audio format and framework wrappers are future ADRs — see `AGENTS.md §7`.
