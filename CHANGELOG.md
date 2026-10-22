# Changelog

All notable changes to Slipmark (formerly DriftGuard) are documented here.

## [Unreleased]

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
  pinned to `slipmark@0.3.0`.

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
