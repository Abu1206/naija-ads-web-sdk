# naija-ads-web-sdk

Canonical web SDK for **Naija Ads**: banner, interstitial, rewarded and audio ads for web games/apps.

- Zero runtime dependencies; strict TypeScript; ESM + browser IIFE.
- Closed Shadow DOM, visible sponsorship labels, keyboard controls and safe-area-aware full-screen UI.
- Server-owned selection/reward logic; paint attestation and ordered, idempotent events.
- Test mode uses the same event path and never bills or earns.

Build rules: [`AGENTS.md`](./AGENTS.md) · Decisions: [`docs/adr/`](./docs/adr/)

## Release status

Version **0.3.0** is prepared for the npm/CDN release and backend OpenAPI **0.5.0**. The registry package is not live until the release owner runs the reviewed publish workflow. Publication uses npm trusted publishing from the protected `npm` environment; no long-lived npm token is stored in this repository. For a pilot build today:

```bash
npm ci
npm pack
# install the generated naija-ads-web-sdk-0.3.0.tgz in the publisher app
```

After publication:

```bash
npm install naija-ads-web-sdk@^0.3.0
```

## Quickstart

```ts
import { initialize } from 'naija-ads-web-sdk';

const ads = initialize({
  appId: 'YOUR_APP_ID',
  baseUrl: 'https://api.naijaads.example',
  mode: 'test', // safe default; live requires approved inventory
});
```

### Banner

```html
<!-- Reserve the expected height in CSS to prevent layout shift. -->
<div id="footer-ad" style="min-height:90px"></div>
```

```ts
const banner = await ads.loadBanner('PLACEMENT_ID', {
  container: document.getElementById('footer-ad')!,
  layout: 'anchored',
  refreshIntervalMs: 60_000, // optional; visible time only, minimum 30s
});
banner.on('impression', () => console.log('attested'));
banner.on('error', console.warn);
```

The server chooses the widest allowed logical size that fits current slot width/height. `ResizeObserver` re-requests after layout/orientation changes. Static 2x/3x assets are downscaled to logical CSS dimensions for sharp screens; GIF remains 1x.

| Layout | Intended position | Logical sizes |
| --- | --- | --- |
| `anchored` | top/bottom strip | 320×50, 320×100, 468×60, 728×90, 970×90 |
| `inline` | scrollable content rectangle | 300×250, 336×280 |

The groups never mix: a 300×250 rectangle cannot unexpectedly replace a footer strip. If no size fits, loading rejects with `code: "no_fill"` and `reason: "no_size_fits"`.

### Interstitial

```ts
const interstitial = await ads.loadInterstitial('PLACEMENT_ID');
const result = await interstitial.show(); // resolves on dismiss/failure
```

Load before a natural break, then show between screens/levels. Media is contained (never cropped), the page behind is inert and scroll-locked, focus stays in the modal, and close remains reachable inside device safe areas.

### Rewarded

```ts
const rewarded = await ads.loadRewarded('PLACEMENT_ID');
const outcome = await rewarded.show();
if (outcome.status === 'confirmed' && outcome.rewardToken) {
  // Send to YOUR server. Never grant in the browser.
}
```

Your server verifies `reward_token` with `POST /v1/rewards/verify` using its SDK secret. Closing early returns `dismissed` and grants nothing. The exit is always available; “non-skippable” means an early exit cannot earn the reward, not that the user is trapped.

### Audio

```ts
const audio = await ads.loadAudio('PLACEMENT_ID', {
  container: document.getElementById('audio-slot')!,
});
```

Audio is an inline, user-initiated player with 44px controls and a required companion banner. Completion is analytics-only.

## Rendering and measurement guarantees

- An impression is sent only after successful media decode/first frame, non-zero rendered geometry and two animation frames. Failure/timeout sends no impression.
- Click/media events queue behind the accepted impression even when browser playback starts first.
- Live ads show `Sponsored`; test ads show `Test ad`. Click surfaces work by keyboard.
- Full-screen formats use `100dvh`, safe-area insets and `object-fit: contain` in portrait or landscape.
- Banner refresh pauses below 50% visibility and while the document is hidden.
- The SDK reports bounded visible fraction/duration observations; the backend applies MRC thresholds. Viewability never affects billing.
- `expires_in` is checked before show. Every loaded full-screen ad is single-use.

## Development

Requires Node 22.18+ for the local toolchain. The published SDK itself has no Node runtime
requirement.

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## Compatibility

| SDK | Backend | Notes |
| --- | --- | --- |
| 0.3.x | OpenAPI 0.5.x / ADR 0022 | canonical four-format renderer, layout-safe sizing, high-DPI, viewability |
| 0.2.x | pre-ADR-0022 | superseded pilot; do not deploy alongside the retired backend SDK |

## License

Apache-2.0. See [`LICENSE`](./LICENSE). The license covers the SDK code; it does not grant rights
to the 9ja Ads name, logos, backend service, or advertising inventory. This repository publishes a
Web SDK only — there is no Android or iOS artifact.
