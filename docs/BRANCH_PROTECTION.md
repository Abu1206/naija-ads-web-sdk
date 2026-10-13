# docs/BRANCH_PROTECTION — naija-ads-web-sdk

Admin checklist (Settings → Branches → rule for `main`):

- [ ] Require a pull request before merging (no direct pushes)
- [ ] Required approvals: 1 (CODEOWNERS routes rewarded/attestation changes to the backend liaison too)
- [ ] Dismiss stale approvals on new pushes
- [ ] Require conversation resolution
- [ ] Require status checks: `ci` (`typecheck`, `test`, `build`)
- [ ] Require branches up to date before merging
- [ ] Block force pushes + deletion
