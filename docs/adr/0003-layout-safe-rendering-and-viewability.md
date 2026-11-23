# ADR 0003: Canonical SDK with layout-safe rendering and viewability observations

- Status: accepted
- Date: 2026-11-15
- Cross-repo: backend ADR 0022; frontend ADR 0010
- Amends: ADR 0001 (paint/refresh), ADR 0002 (isolated audio card)

## Decision

1. This TypeScript package is the sole web SDK source. The backend's hand-written bundle is retired.
2. Every renderer uses a closed Shadow DOM. Live units always show visible `Sponsored` attribution; click surfaces are keyboard controls.
3. Banner placement layout is explicit: `anchored` strips and `inline` rectangles never share a size list. The SDK sends current slot width and a height ceiling, re-requests on material resize/orientation change, and renders the server's logical size without cropping. Static 2x/3x assets render at logical CSS dimensions.
4. Full-screen hosts use dynamic viewport units, `object-fit: contain`, safe-area controls, body scroll lock, inert background content, trapped focus and restored focus. Exit is always available; leaving rewarded early grants nothing.
5. Paint error/timeout rejects with `creative_failed` and sends no impression. Click/media events await an accepted impression even when browser playback fires first. `expires_in` is checked before show.
6. Banner refresh is disabled by default, at least 30 seconds when enabled, and accumulates only while ≥50% visible in a visible document. Sixty seconds is recommended.
7. A lightweight `IntersectionObserver` tracker sends bounded raw `viewability` observations. The backend applies thresholds and stores the verdict; the SDK never labels itself viewable.
8. Test mode uses the same impression/click/media path without navigation or rewards, so a dashboard test verifies real integration plumbing.

## Consequences

- 0.3.0 is coordinated with backend OpenAPI 0.5.0 and is not compatible with servers that reject the new event/geometry fields.
- The package remains zero-runtime-dependency. Isolation, geometry and modal behavior are implemented in core rather than delegated to a UI framework.
- Browser visual-matrix checks supplement deterministic jsdom tests; no third-party creative script executes in the SDK.
