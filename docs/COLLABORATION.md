# COLLABORATION — naija-ads-web-sdk

Roles, ownership, and how the SDK stays in lockstep with the backend. Daily workflow: `CONTRIBUTING.md`.

## 1. Team & roles

| Role | Owns |
| ---- | ---- |
| SDK owner | `src/**`, releases, npm publishing, `AGENTS.md` |
| Backend liaison | contract sync: wire types, error codes, ADR watchlist (0004/0010/0012/0014/0019) |
| Docs & DX | README, demo page, integration guides, R10-style diagnostics quality |

Small team → one person, several hats. CODEOWNERS still routes reviews.

## 2. Ownership (see `.github/CODEOWNERS`)

- `src/rewarded.ts` + `src/base.ts` (reward/attestation invariants) → SDK owner + backend liaison.
- `AGENTS.md`, `docs/adr/**` → SDK owner.
- Everything else → SDK owner by default until the team grows.

## 3. Branch protection (see `docs/BRANCH_PROTECTION.md`)

`main`: require PR, 1 approval, status checks (`ci`: typecheck + test + build), conversation resolution, no force-pushes. No direct pushes.

## 4. Contract sync protocol

1. Backend ADR lands → backend liaison opens a `contract` issue here summarizing the delta.
2. Changes ship as an SDK PR linked to that issue + the backend PR.
3. Verify against a running backend (local or staging) before merge; record the backend tag in the PR.
4. Breaking changes: deprecate in a minor release, remove in the next major; note both in README compatibility table.

## 5. Environments

- Dev: `npm run dev`-style loop is `vitest` watch + the `demo/` page against `http://localhost:8080` (backend `go run ./cmd/api`).
- Staging: point `baseUrl` at the backend staging deployment (test mode only).
- No secrets anywhere in this repo — `APP_ID` is public by design (backend `AGENTS.md §6.7`).

## 6. Ready / Done

Ready: scoped issue, contract impact identified (or "none"), test plan per `AGENTS.md §6`.
Done: code + tests + docs, CI green, review per CODEOWNERS, squash-merged, README/AGENTS updated if behavior changed, compatibility table touched for any contract-adjacent change.

## 7. Releases

Tag `v0.Y.Z` → CI builds `dist/` → tech lead publishes npm. Release notes list: features, fixes, **backend tag verified against**, bundle size. Never commit `dist/`.
