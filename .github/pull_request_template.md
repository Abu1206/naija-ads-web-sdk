## Linked issue

Closes # (required, except tiny `docs:` fixes)

## What / why

<!-- problem + approach. If the wire contract changed: link the backend issue/PR (CONTRIBUTING.md §3). -->

## Test evidence (required)

```text
npm run typecheck
npm test
npm run build
```

- [ ] Tests added/extended per AGENTS.md §6 matrix
- [ ] Regression test first (for bug fixes)
- [ ] Bundle size before → after (`ls -l dist`): ___ → ___
- [ ] No new runtime dependencies (or ADR linked)

## Contract impact

- [ ] No wire change, or backend PR linked: ___
- [ ] Backend tag verified against: ___

## Invariant check (AGENTS.md §4)

- [ ] Impression attested after paint, carries render token
- [ ] Served click_url opened as-is; click event only after impression accepted
- [ ] Same event_id across retries; server-decided rewards only
- [ ] Test mode labelled, built-in creatives, identical event flow
- [ ] Failure paths emit typed codes + hints (R10), no silent no-fill
