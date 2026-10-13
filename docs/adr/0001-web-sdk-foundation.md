# ADR 0001: Web SDK foundation — surface, test mode, reward flow

- Status: accepted
- Date: 2026-10-13
- Context: Backend ADR 0005 made web the first SDK target (Phase 2: "web SDK foundation (banner, interstitial, rewarded)"). The backend contract (internal/ads) was already live: request/response shapes, render attestation (ADR 0010), adaptive banners (ADR 0012), video/GIF creatives (ADR 0014), audio + click URLs (ADR 0019).

## Decisions

1. **Vanilla TypeScript, zero runtime dependencies.** Ships into other people's games; IIFE bundle for `<script>` embedding plus ESM for bundlers. No framework lock-in.
2. **Promise-based surface mirroring spec §7** (`initialize/loadBanner/loadInterstitial/loadRewarded/destroyAll`), extended with event subscriptions (`on/off`) instead of global callbacks.
3. **No-fill = promise rejection** with `NaijaAdsError.code === 'no_fill'` and the server's `reason` — idiomatic JS, keeps `load*` signatures honest.
4. **`mode` defaults to `test`.** Live is explicit. Test mode renders clearly labelled built-in placeholders and runs the identical event flow, because the test response carries no creative (backend ADR 0004).
5. **Render attestation after paint** (ADR 0010): impression waits for media decode/first frame + double rAF, carries the server-issued `render_token`; the wait has a capped fallback so hung media can't stall the impression forever.
6. **Rewards surface the server's decision.** `show()` resolves confirmed/rejected/dismissed; `reward_token` is handed to the developer whose **game server** must verify it server-to-server (`POST /v1/rewards/verify`, Bearer secret). The SDK never grants, never stores secrets.
7. **`client_ts` off by default.** A device clock ahead of server time would get events rejected (`clock_skew`); timestamps are diagnostic-only per ADR 0010, so the SDK sends nothing unless configured.
8. **Click-through = open the served `click_url` in a new tab** with `noopener,noreferrer`; the click event is fire-and-forget with keepalive. Navigation happens inside the user gesture to survive popup blocking.
9. **Banner refresh ≥ 15s** (config), implemented as a full re-request (new impression), matching "define refresh + impression rules" in the backend build notes.

## Consequences

- Audio format (ADR 0019) is intentionally absent; needs its own ADR (player UI + companion banner + placement rules).
- jsdom tests cannot load media: paint detection carries a test-only timeout override (`setPaintTimeoutForTests`, not exported from the bundle).
- A `destroy()` racing a just-painted impression still attests (the impression happened; money was reserved at serve) — covered by tests.
