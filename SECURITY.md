# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.3.x | Yes — security fixes |
| 0.2.x and earlier | No — upgrade before reporting |

The SDK has no runtime dependencies. It is a browser package; the Naija Ads backend, auction,
pricing, rewards and viewability verdicts remain server-owned.

## Reporting a vulnerability

Do **not** open a public issue, discussion or pull request for a suspected vulnerability.

Use GitHub's private advisory flow:

1. Open the repository **Security** tab.
2. Choose **Report a vulnerability**.
3. Include the affected SDK version, browser/platform, reproduction steps or proof of concept,
   observed impact, and any suggested fix.

Reports stay private while we investigate. If the issue also affects the private backend or
dashboard repositories, say so and we will route it to the correct owner.

## What to expect

- We aim to acknowledge a report within 3 business days.
- We aim to complete initial triage within 10 business days.
- We will agree on a disclosure timeline with the reporter and credit reporters who want credit.
- There is no paid bug-bounty programme.

## In scope

- Script injection or DOM XSS through served creative fields, click URLs, metadata or diagnostics.
- Click-through scheme/redirect handling that could execute code or leak credentials.
- Reward-token handling that lets a page grant or replay a reward without the server.
- Event forgery or ordering flaws that create billable impressions without a rendered ad.
- Focus, overlay or full-screen behaviour that traps users or hides the sponsorship/test label.
- Packaging or release compromise affecting the published npm artefact.

## Out of scope

- Ad-content policy complaints, review decisions or account suspensions.
- Vulnerabilities only present in the private backend or dashboards; report them privately and we
  will route them.
- Volumetric denial of service, spam or social engineering.
- Findings that require a compromised browser, extension, device or npm account.
- Automated dependency reports already covered by Dependabot alerts.

## Research rules

Use test mode and local fixtures. Do not access other users' data, disrupt production traffic,
publish details before coordination, or test against live advertiser campaigns. Never include real
credentials, tokens or personal data in a report.
