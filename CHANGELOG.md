# Changelog

All notable changes to DriftGuard are documented here.

## [Unreleased]

### Added
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
