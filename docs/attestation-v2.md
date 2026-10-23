# Attestation v2 (draft spec)

> Status: **partly built.** On `main`, unreleased: `against`, `--run` and
> `--check`, `agent.model`, `kind`, diff coverage, `models.allow`, and the
> `against_changed`, `check_failed`, `model_not_allowed` and `uncovered`
> statuses. Still draft: quorum, per-path rules, `requireWitnessedChecks`,
> delta re-attestation, human override reasons and hash modes. How to use the
> built parts: [attestation.md](./attestation.md). Comments welcome in issues.

v1 proves a verdict is about the bytes you are shipping. v2 makes weak
verdicts harder to get through the gate, without Slipmark ever judging whether
an agent was right.

It adds four things:

1. **Richer attestations:** which model gave the verdict, what it was checked
   against, and which checks actually ran.
2. **A policy file:** coverage of every changed file, quorum on sensitive
   paths, allowed models.
3. **Delta re-attestation:** re-review only what changed since the last
   verdict.
4. **Human overrides that are recorded, not silent.**

Hash modes (formatting-tolerant hashing) are specified separately in
[hash-modes.md](./hash-modes.md).

## The rule behind every field

Every field is either **witnessed** or **claimed**.

- **Witnessed:** Slipmark computed it. File hashes, the output of a command
  Slipmark ran itself, the files changed against a base commit.
- **Claimed:** the attester said it. The model name, a check the agent says it
  ran, the free-text note.

The gate only ever *trusts* witnessed fields. Claimed fields are recorded,
shown in reports and used to match policies, and every report labels them as
claims. Slipmark never presents a claim as proof.

A witnessed field is only as trustworthy as the machine that ran
`slipmark attest`. On a laptop, "witnessed" means "that laptop computed it".
Signing attestations in CI (see [Later](#later)) is what turns that into
evidence a third party can check.

## Schema: `slipmark/attestation@2`

```json
{
  "schema": "slipmark/attestation@2",
  "by": "security-audit",
  "kind": "agent",
  "verdict": "cleared",
  "at": "2026-10-23T09:00:00.000Z",
  "agent": {
    "model": "claude-opus-5-5",
    "harness": "claude-code",
    "harnessVersion": "2.4.1"
  },
  "against": [
    { "path": ".slipmark/policies/security-audit.md", "sha256": "<64 hex>" }
  ],
  "subjects": [
    {
      "path": "src/auth/session.ts",
      "sha256": "<64 hex>",
      "digests": { "normalised@1": "<64 hex>", "ast:ts@1": "<64 hex>" }
    }
  ],
  "checks": [
    {
      "command": "npm test -- src/auth",
      "exitCode": 0,
      "outputSha256": "<64 hex>",
      "durationMs": 4123,
      "witnessed": true
    }
  ],
  "review": {
    "mode": "delta",
    "supersedes": "<sha256 of the previous attestation file>",
    "from": "<subject sha256 the previous verdict was about>",
    "diffSha256": "<64 hex>",
    "diffLines": 3,
    "chain": 1
  },
  "note": "Session expiry now enforced server side. No new findings."
}
```

| Field | Witnessed or claimed | Required | Notes |
|---|---|---|---|
| `schema` | | yes | `slipmark/attestation@2` |
| `by` | claimed | yes | Role name, as in v1. Humans use `human:<name>`. |
| `kind` | claimed | no | `agent` (default), `tool` or `human`. |
| `verdict` | claimed | yes | As in v1. `pass` and `cleared` can clear the gate. |
| `at` | claimed | yes | Informational, as in v1. |
| `agent.model` | claimed | no | From `--model`, `SLIPMARK_MODEL`, or the Claude Code plugin. Used for policy matching only. |
| `agent.harness`, `harnessVersion` | claimed | no | Informational. |
| `against` | witnessed | no | Files the verdict was checked **against** (a spec, a review checklist, a security policy). Hashed exactly like subjects. If one changes, the verdict stops counting. |
| `subjects[].sha256` | witnessed | yes | Byte hash, unchanged from v1. |
| `subjects[].digests` | witnessed | no | Extra hashes for [hash modes](./hash-modes.md). Always recorded when available. The **policy**, not the attester, decides which one clears. |
| `checks[]` with `witnessed: true` | witnessed | no | Slipmark ran the command itself (`--run`). |
| `checks[]` with `witnessed: false` | claimed | no | The agent says it ran it (`--check`). |
| `review` | witnessed | no | Present only for delta re-attestation. |
| `note` | claimed | no | Informational. |

`against` is separate from `subjects` so reports can say *what* was reviewed
and *what it was reviewed against*. Both are gated the same way.

### Checks Slipmark runs itself

```bash
slipmark attest --by security-audit --verdict cleared \
  --subject src/auth/session.ts \
  --against .slipmark/policies/security-audit.md \
  --run "npm test -- src/auth" \
  --run "npx semgrep --config auto src/auth"
```

`--run` executes each command from the repo root before writing anything. It
records the exit code and the SHA-256 of the combined output. If any `--run`
command exits non-zero, `attest` refuses to write a passing verdict.

`--check "npm test=0"` records a claimed check without running it, for
harnesses where Slipmark can't run the command.

## Policy file: `.slipmark/policy.json`

Optional. Without it, `verify` behaves exactly as v1.

```json
{
  "schema": "slipmark/policy@1",
  "coverage": {
    "mode": "diff",
    "base": "origin/main",
    "ignore": [".slipmark/**", "**/*.lock", "docs/**"]
  },
  "rules": [
    {
      "paths": ["src/auth/**", "src/billing/**"],
      "quorum": { "min": 2, "distinct": "model" },
      "requireWitnessedChecks": true,
      "allowHuman": false,
      "hash": "byte"
    },
    {
      "paths": ["src/**/*.ts", "src/**/*.tsx"],
      "hash": "ast",
      "delta": { "maxChain": 5, "maxLines": 200 },
      "allowHuman": ["formatting"]
    }
  ],
  "models": {
    "allow": ["claude-opus-5-5", "claude-sonnet-5-5"]
  }
}
```

The first rule whose `paths` match a file applies. Files no rule matches use
the defaults: byte hash, quorum of 1, no human overrides, deltas allowed.

### Coverage

`coverage.mode: "diff"` makes `verify` compute the changed files itself
(`git diff --name-only <base>...HEAD`) and require a current, passing verdict
for each one not in `ignore`. It is `--require` filled in automatically from
the diff. The changed-file list is computed at verify time, never read from an
attestation.

This closes the gap where an agent reviews 3 of 7 changed files and the other
4 sail through.

CLI equivalent: `slipmark verify --coverage diff --base origin/main`.

### Quorum

`quorum.min` is how many independent, current, passing verdicts a file needs.
`distinct` says what makes them independent:

| `distinct` | Counts as independent when |
|---|---|
| `by` | Different role names |
| `model` | Different `agent.model` values. Attestations with no model count once between them. |
| `kind` | Different kinds, for example one `agent` plus one `tool` |

`distinct: "model"` relies on a claimed field. It raises the bar against
accidental single points of failure. It is not proof against an attester that
lies about its model. Reports say so.

### Allowed models

`models.allow` lists the models whose verdicts count. Remove an old model
from the list and its verdicts stop counting: that is how you force a
re-review when you change models. v1 attestations and v2 attestations with no
`agent.model` never satisfy a policy with `models.allow` set.

### `requireWitnessedChecks`

The verdict must include at least one `--run` check with exit code 0.

## Delta re-attestation

The fix for "a typo fix shouldn't need a full re-review".

```bash
slipmark diff-since src/export.ts         # what changed since the last verdict
slipmark attest --delta --by reviewer --verdict pass --subject src/export.ts
```

How it works:

1. At attest time, Slipmark stores the attested content in the local git
   object database (`git hash-object -w`) and records the blob id. This is
   what makes the old version recoverable later.
2. `diff-since` prints the diff between the attested version and the file as
   it is now. The agent reviews that diff, plus the previous verdict's note.
3. `attest --delta` writes a new attestation for the current bytes, with a
   `review` block linking it to the previous one. The previous attestation
   moves to `.slipmark/attestations/superseded/`, which `verify` reads for
   chain checks but never counts as a verdict.

`verify` checks the chain: `review.from` must equal the subject hash of the
attestation named in `review.supersedes`. A broken chain is `invalid`.

Policy limits (`delta.maxChain`, `delta.maxLines`) force a full re-read after
too many deltas or too large a change. Exceeding them is `delta_limit`.

The Claude Code plugin's stop hook will use this: when a signed-off file
changes, it asks Claude to review the diff and re-attest with `--delta`.

## Human overrides

```bash
slipmark attest --by human:paul --kind human --verdict pass \
  --reason formatting --subject src/export.ts
```

- `--reason` is required: `formatting`, `trivial` or `other` (with `--note`).
- A policy rule decides whether human verdicts count, and for which reasons
  (`allowHuman: true`, `false`, or a list of reasons).
- Overrides are attestations like any other. They show up in every report
  and in Slipmark Cloud, where the override rate per repo is visible.

Locally, `human:paul` is a claim. In CI, Slipmark Cloud records the GitHub
actor from the Actions OIDC token alongside it.

## New `verify` statuses

| Status | Meaning |
|---|---|
| `uncovered` | Coverage is on and a changed file has no current, passing verdict |
| `quorum_not_met` | Fewer independent verdicts than the rule requires |
| `model_not_allowed` | Verdict from a model not in `models.allow`, or no model given |
| `check_failed` | A witnessed check recorded a non-zero exit code |
| `checks_required` | The rule requires a witnessed check and there isn't one |
| `against_changed` | A file the verdict was checked against has changed |
| `human_not_allowed` | Human verdict where the rule doesn't allow one, or not for that reason |
| `delta_limit` | Delta chain too long or diff too large for the rule |
| `hash_mismatch` | As v1. Now also says `formatting only` when the digests can tell. See [hash-modes.md](./hash-modes.md). |

All v1 statuses keep their meaning.

## Compatibility

- `verify` reads `@1` and `@2` side by side. An `@1` attestation is treated as
  `kind: agent`, byte hash only, no model, no checks.
- `attest` writes `@2` only when a v2 option is used (`--against`, `--run`,
  `--check`, `--model`, `--harness`, `--kind`). Otherwise it writes `@1`, so
  older verifiers keep working.
- With no `policy.json`, v0.5 `verify` gives the same answer as v0.4 on the
  same inputs. That is a release blocker, covered by tests.

## Later

Not in v2, listed so the schema leaves room for them:

- **Signed attestations.** Sign in CI with Sigstore keyless signing against
  the GitHub Actions OIDC identity, so `by`, `kind` and witnessed checks become
  verifiable by a third party. Cloud already uses the same OIDC token for
  uploads.
- **Miss ledger (Slipmark Cloud).** When a bug or CVE later lands on a file
  version that was attested `pass`, link it back to that verdict. Over time
  this gives a miss rate per model, per role and per policy: an honest answer
  to "how good are our agents' verdicts?" that Slipmark never has to guess.
- **Non-file subjects** that still have a stable hash: `terraform plan`
  output, OpenAPI specs, container image digests, SQL migrations. Live
  databases and vector stores are out of scope.
