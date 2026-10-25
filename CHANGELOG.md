# Changelog

All notable changes to Slipmark (formerly DriftGuard) are documented here.

## [Unreleased]

### Security
- **The policy is read from the base branch** (thanks Kent Bodrov). Before,
  `verify` read `.slipmark/policy.json` from the pull request's own checkout,
  so a PR could loosen the rules it was judged by, for example by dropping a
  required path. Now the policy comes from `--policy-from <ref>`, the coverage
  base, or the pull request's base branch in GitHub Actions (the Action
  fetches it). A branch that changes the policy gets a notice and the change
  applies after merge. Local runs with no base behave as before.
  `--policy-from working-tree` restores the old behaviour. Subfolder runs
  read that folder's policy from the base, as they do from disk. The pull
  request's base is looked up by its full ref name, so a tag can't pose as it.
- Every report records the policy that decided it: `policy.source`,
  `policy.ref` and `policy.sha256`, in `--json` output and in Slipmark Cloud.

### Added
- `require` in `.slipmark/policy.json`: required paths kept with the policy,
  so they are read from the base branch too. The Action's `require` input is
  in the workflow file, which a pull request can still edit.
- The Action's `policy-from` input.
- **Diff coverage.** `slipmark verify --coverage diff --base <ref>` refuses
  any file changed since the base that no current, passing verdict covers
  (new status `uncovered`). `--ignore <glob>` leaves paths out. The Action
  gains `coverage-base` and `coverage-ignore` inputs.
- **`.slipmark/policy.json`** (`slipmark/policy@1`): coverage settings and
  `models.allow`. Read automatically by `verify`, `upload` and the Action;
  `--no-policy` skips it.
- **Attestation v2 fields**, written only when used, so `@1` stays the
  default: `--against <file>` (status `against_changed`), `--run "<cmd>"`
  (Slipmark runs it and records exit code and output hash),
  `--check "<cmd>=<code>"` (a recorded claim), `--model` /
  `SLIPMARK_MODEL`, `--harness`, `--kind`. A passing verdict is refused when
  any check failed. `verify` reads `@1` and `@2`; new statuses
  `check_failed` and `model_not_allowed`.
- `verify` exits 2 when it can't run (malformed policy, coverage base not in
  the checkout) instead of reporting a refusal.
- **Signed verdicts.** `slipmark attest --sign` signs the attestation with the
  job's own identity through Sigstore keyless signing (GitHub Actions with
  `id-token: write`, or `SIGSTORE_ID_TOKEN`). The bundle is stored in the
  attestation's `signature` field and logged in Rekor. `verify` checks every
  signature: one that fails, or an attestation edited after signing, refuses as
  `signature_invalid`. `--require-signed` with `--trusted-signer <identity>`
  (or `signatures` in the policy file, or the Action's `require-signed` and
  `trusted-signers` inputs) counts only verdicts signed by a trusted workflow;
  others refuse as `unsigned` or `signer_not_trusted`. Verified results name
  their signer.

### Changed
- The Claude Code plugin's stop hook also flags verdicts whose `--against`
  files changed, and ignores the policy so a missing coverage base never
  silences it.
- `upload` receives the same `--require` and coverage settings as `verify`, so
  Cloud records the same report as the gate.

## [0.4.0] - 2026-10-23

### Security
- Subject paths are now resolved through symlinks and re-checked against the
  real repository root. A symlink inside the repository that points outside it
  was previously followed and hashed. Found by a Claude Code review of
  `attestation.ts` against `docs/attestation.md`.

### Fixed
- File names that merely start with `..` (for example `..notes.md`) are no
  longer rejected as escaping the repository.

### Added
- Slipmark gates its own code: `.slipmark/attestations/` holds a real review
  verdict, required by CI and recorded in Slipmark Cloud.
- `slipmark upload` and the Action's `cloud` input record runs in Slipmark
  Cloud (app.slipmark.dev) using the GitHub Actions OIDC token.
- **Claude Code plugin** in `claude-plugin/`, installable from this repo as a
  marketplace (`/plugin marketplace add founder-ship-it/Slipmark`). A skill
  that records verdicts, `/slipmark:verify`, `/slipmark:setup`, and a Stop hook
  that asks Claude to re-attest when an attested file has changed. Commands are
  pinned to `slipmark@0.4.0`.

## [0.3.0] - 2026-10-22

### Added
- **`npx slipmark init`** sets up a repository in one command: the
  attestation directory, a GitHub workflow and instructions for coding agents.
  The workflow starts in report-only mode, because a repository with no
  verdicts yet would otherwise fail its first run.
- **Agent instructions** in `AGENTS.md`, and in `CLAUDE.md`, Cursor rules or
  Copilot instructions when the repository already uses them. The block is
  fenced with markers, so re-running `init` updates it in place.
- `slipmark --help` and `slipmark --version`.
- [docs/agents.md](./docs/agents.md): setup for Claude Code, Cursor, Copilot
  and Codex, and how to check agents are attesting.
- Published to npm as `slipmark`.

### Changed
- `verify` with no attestations at all now explains how to record the first
  one instead of telling you to re-run the agent.
- `attest` prints the path it wrote relative to the current directory.

## [0.2.0] - 2026-10-17

### Changed (breaking)
- **Renamed DriftGuard to Slipmark.** A slip mark is the paint line engineers
  draw across a tightened bolt: if the bolt moves, the line breaks. "DriftGuard"
  is a registered trade mark of other companies for related software.
- CLI command `driftguard` is now `slipmark`.
- Default attestation directory `.driftguard/attestations` is now
  `.slipmark/attestations`.
- Attestation schema `driftguard/attestation@1` is now `slipmark/attestation@1`.
- GitHub Action: `uses: founder-ship-it/Slipmark@v0.2.0`.
- New logo, social preview and Marketplace icon.

## [0.1.2] - 2026-10-17

### Changed
- Brand: RIG-style logo and social preview in `assets/`; Marketplace icon is now
  `hash` in `gray-dark` to match.

## [0.1.1] - 2026-10-17

### Added
- Action output `result` (`passed` or `refused`) and a report-only mode,
  `fail-on-refusal: "false"`, for rolling DriftGuard out without blocking builds.

### Changed
- CI demo steps now pass only when DriftGuard refuses the planted problems,
  instead of showing as errors on the Actions page.

## [0.1.0] - 2026-10-17

### Added
- **Verdict attestation gate.** `driftguard attest` records an agent's verdict
  with the SHA-256 of every file it read. `driftguard verify` re-hashes them on
  the current tree and refuses on `hash_mismatch`, `subject_missing`,
  `verdict_not_passing`, `unattested` (`--require`) or `invalid`. An empty gate
  refuses rather than passing. Subject paths outside the repo are rejected.
- **GitHub Action** (`action.yml`): `uses: founder-ship-it/driftguard@v0.1.0`.
- Worked example in `examples/attestation/` with one deliberately stale verdict;
  `npm run demo:verify`.
- 10 tests for the gate, including the wrong-branch scenario.

### Changed
- **License: MIT to Apache-2.0** (explicit patent grant). Added `NOTICE`.
- `package.json`: `bin`, `main` and `types` now point at `dist/src/`, where the
  build actually writes them.
- **Self-serve authoring** — define packs in plain JSON with target commands and
  declarative assertions (`contains`, `not_contains`, `matches`, `not_matches`,
  `equals`, `not_equals`); golden mode for recorded outputs. No TypeScript needed.
- **Git bisection host adapter** — `driftguard bisect` / `runGitBisect` checks out
  real commits, runs a probe, finds the culprit in ~log₂(n) steps, and restores
  the working tree.
- **Earned causal evidence** — execution traces (self-instrumenting locks),
  changed-watched-symbol detection, and a real bisection signal, feeding a
  three-tier honesty cap (no evidence 0.40 → trace-only 0.69 → diff/bisect
  uncapped). Repair prompts gain a "Causal evidence" section.
- **Coding-agent integration** — `--emit` writes per-lock repair prompts, an
  index, and an `AGENT_RULES` doc; Claude Code invocation helper.
- **Domain-agnostic engine + `Pack` model** — signatures, scorer, confidence,
  repair-prompt generator; ships a non-product demo proving generalization.
- Docs: `docs/concepts.md`, `docs/authoring.md`, `CONTRIBUTING.md`.

### Fixed
- CI workflow no longer fails on the demo pack's intentional planted drift
  (informational step).

## [0.0.1]
- Initial scaffold.
