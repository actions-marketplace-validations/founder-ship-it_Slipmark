# Changelog

All notable changes to DriftGuard are documented here.

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
