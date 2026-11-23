# CONTRIBUTING — naija-ads-web-sdk

Companion docs: [`AGENTS.md`](./AGENTS.md) (build rules + invariants) · [`docs/COLLABORATION.md`](./docs/COLLABORATION.md) (roles, reviews, releases).

## 1. Branches

- `main` — protected, always releasable.
- Short-lived: `feat/<issue#>-<slug>`, `fix/…`, `chore/…`, `docs/…`. One branch = one issue = one PR. Rebase before review, delete after merge.

## 2. Commits — Conventional Commits

```
feat(rewarded): resolve dismissals before the creative paints
fix(client): throw mapped errors for all non-2xx responses
test(banner): cover adaptive slot_width_dp measurement
docs: document reward server verification requirement
```

Types: `feat fix test docs chore refactor perf ci build`. Scope = module (`client`, `banner`, `interstitial`, `rewarded`, `render`, `base`…).

## 3. Contract changes are cross-repo

The wire format mirrors the Go backend. Renaming a field, adding an endpoint, or changing an error code **requires a linked backend issue/PR** (RFC per backend `AGENTS.md §13`) in the PR description. Never adapt silently.

## 4. Pull requests

- **< 400 lines**, focused, CI green (`typecheck`, `test`, `build`).
- Template requires: linked issue, what/why, **test evidence** (`npm run typecheck` + `npm test` output), contract impact note (backend tag verified against), bundle-size delta for core changes (`ls -l dist` before/after).
- **Zero runtime dependencies is enforced by review**: no new `dependencies` entries without an ADR.
- Every bug fix ships a failing-first regression test (see `AGENTS.md §6` matrix).
- Squash-merge; title = conventional commit; `Closes #n`.

## 5. Reviews

- 1 approval; SDK contract or reward-flow changes also need the backend liaison (see `CODEOWNERS`).
- Reviewers check the invariants in `AGENTS.md §4`: render attestation after paint, served `click_url` only, same `event_id` on retry, server-decided rewards, no secrets, labelled test mode, diagnostics on every failure path.
- 24h weekday SLA; escalate in standup after that.

## 6. Releases

Semver `v0.Y.Z` tags from `main`; release notes from `git log` between tags. Publishing runs from
the protected `npm` environment using npm trusted publishing (OIDC), so no long-lived npm token is
stored here. Only the tech lead pushes a release tag; `dist/` is built fresh in CI, never committed.
Update the README compatibility table with the backend tag used for verification and confirm the
provenance badge on npm after publication.
