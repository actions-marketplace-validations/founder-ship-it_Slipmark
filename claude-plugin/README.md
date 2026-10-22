# Slipmark for Claude Code

Make Claude prove what it checked. When Claude gives a verdict (a review
passed or failed, an audit cleared, a spec approved), this plugin has it record
the verdict together with the SHA-256 of every file the verdict was based on.
If one of those files changes afterwards, the verdict stops counting until
Claude reads it again.

It is the Claude Code side of [Slipmark](https://github.com/founder-ship-it/Slipmark),
an open-source attestation gate that also runs in CI as a GitHub Action.

## Install

```text
/plugin marketplace add founder-ship-it/Slipmark
/plugin install slipmark@slipmark
```

New to Slipmark in this repository? Run `/slipmark:setup`.

## What it adds

| Part | What it does |
| --- | --- |
| `attest-verdicts` skill | Claude loads it when it gives a verdict, and records one with `npx slipmark@0.3.0 attest`. |
| `/slipmark:verify` | Runs `npx slipmark@0.3.0 verify` and explains any refusal. |
| `/slipmark:setup` | Shows, then runs, `npx slipmark@0.3.0 init` to add the workflow and agent instructions. |
| Stop hook | After each response, if `.slipmark/attestations/` exists, re-checks the verdicts. If a file changed after it was attested, Claude is asked once to re-read it and attest again. |

## What it runs, sends and stores

- Every command is the pinned npm package `slipmark@0.3.0`, fetched by `npx`
  from the npm registry the first time. Nothing else is downloaded.
- The Stop hook does nothing in repositories without `.slipmark/attestations/`.
  It never blocks on an honest `fail` verdict and never blocks twice in a row.
- Attestations are JSON files written to `.slipmark/attestations/` in your
  repository. Nothing is sent anywhere. No account, no network calls beyond npm.

## Licence

Apache-2.0. Built by [Reply Intelligence Group](https://www.replyintelligencegroup.co.uk/products/slipmark), Watford, UK.
