# ADR 0002: Audio ads — player UI, companion banner, event flow

- Status: accepted (amends ADR 0001's "audio is intentionally absent")
- Date: 2026-10-16
- Context: The backend fully supports audio (backend ADR 0019): `audio` placements carry no size — the **companion banner does** (`companion_url` + `companion_size`); `audio_started`/`audio_completed` events are accepted on audio formats only and are **analytics-only** (no reward, no money effect). Creatives are MP3/AAC ≤ 30s with a required companion banner. Adding audio completes all four MVP formats in the SDK.

## Decisions

1. **Inline card player, not an overlay.** Audio belongs in the page (podcast pre-roll, game menu); a full-screen takeover fits interstitial/rewarded only.
2. **Custom minimal controls over native ones.** A play/pause button + progress bar + the companion banner. Native `<audio controls>` is inconsistent across browsers and shows the media URL. The `<audio>` element itself is rendered without `controls` and drives state.
3. **No autoplay.** Browsers block audible autoplay; the developer's user presses play. `audio_started` fires on first `playing` — which also makes the event flow naturally ordered (impression attests at render, before any playback).
4. **Impression attests when the card painted** (companion banner visible, + double rAF), carrying the render token per ADR 0010 — identical to every other format. Audio buffering is not a visible event, so it does not gate attestation.
5. **Companion banner is the click surface.** It renders at `companion_size` (parsed "WxH", capped to container) and opens the served `click_url`; the audio element itself is not clickable (taps mean play/pause).
6. **Completion = `ended` → `audio_completed`.** No reward semantics; pausing early sends nothing further.
7. **Test mode simulates a 5s track** (configurable `testAudioDurationMs`) with the same play → progress → completed flow and a labelled companion strip, matching the ADR 0004 "identical event flow, built-in creatives" rule.

## Consequences

- `loadAudio(placementId, { container, testAudioDurationMs? })` joins the public surface; `AudioAd` follows the `BannerAd` lifecycle (inline render, `destroy()`).
- Progress for live creatives derives from `duration_ms` + `timeupdate`; test mode uses the interval tick shared with the rewarded simulator.
- Bundle grows slightly; still zero dependencies, target < 25 KB minified IIFE.
