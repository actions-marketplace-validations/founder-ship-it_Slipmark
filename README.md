# DriftGuard

**Regression locks + honest failure diagnosis for AI/LLM features.**

Define behavioral invariants ("locks") for your AI features. When a code or
prompt change makes one fail, DriftGuard tells you *what likely broke it*, how
confident it is (and refuses to fake confidence it doesn't have), and hands your
coding agent a ready-to-run **repair prompt**.

It is **CI-first** and **domain-agnostic**: the engine knows nothing about your
product. You supply a `Pack` (signatures, system map, constraints, locks) and the
same engine works on any codebase.

> Status: early scaffold (`v0.0.1`). The engine, confidence model, repair-prompt
> generator, and a working non-product demo are in place. See the roadmap below.

---

## Why it's different

Most AI-eval / observability tools focus on **detection** (score outputs, flag a
regression, draw a dashboard). DriftGuard's distinctive half is **diagnosis +
repair**, and it is deliberately honest about certainty.

**Confidence is earned, not guessed — a three-tier honesty cap:**

| Evidence available | Confidence ceiling | Meaning |
|---|---|---|
| Signature/pattern only | **0.40** (low/medium) | A heuristic, not proof — `investigate_first` |
| + execution trace | **0.69** (medium) | We know the *mechanism*, not the commit |
| + git diff **or** bisected commit | **uncapped** (up to high) | Causal evidence links it to a specific change |

- **It refuses to fake precision.** At low confidence it **withholds ranked files
  entirely** and flips into an explicit *investigation mode* ("do not apply blind
  fixes").
- **The repair prompt is mode-gated** — `suggest_patch` (high), `minimal_fix`
  (medium), `investigate_first` (low) — so an agent gets the right amount of rope.
- **Anti-gaming:** every prompt forbids editing the lock/fixtures to force a pass.

### Earned causal evidence

When the evidence exists, DriftGuard surfaces the smoking gun, not a guess:

- **Execution traces** — a lock instruments itself (modules/symbols exercised,
  observations like `intentSourceUsed="first"`), so diagnosis is backed by what
  the code *actually did*.
- **Bisection** — `bisectFirstFailing()` is a real "git-bisect for AI behavior":
  given a commit history and a probe, it binary-searches the culprit commit in
  ~log₂(n) steps. The host supplies the probe (check out + re-run); the engine
  owns the algorithm.
- **Changed watched-symbols** — a lock declares the symbols its invariant depends
  on; when the diff changes one of them, that's earned evidence the specific code
  behind the behavior moved.

## Quick start

```bash
npm install
npm run build
npm test           # 5 tests, all green
npm run demo       # runs the non-product demo pack with a sample git diff
```

The demo (`packs/demo-shop`) is an e-commerce support assistant — **deliberately
not the original product** — to prove the engine generalizes. It ships with one
planted regression so you can watch DriftGuard catch and diagnose it.

```
DriftGuard — pack `demo-shop`
  1 passed · 1 drifted · 0 errored (of 2)
  ✗ shop.latest_intent_wins — drift
      cause: Likely: stale intent carryover …  Probable hot-spot: `…/shopAssist.ts` (85% relevance).
      confidence: high (86%) · severity: high · mode: suggest_patch
```

Flip `PLANTED_BUG` to `false` in `packs/demo-shop/shopAssist.ts` and the lock
turns green.

## How it works

```
locks (your behavioral invariants)
   │  run() → pass / drift + failed assertions
   ▼
engine
   ├─ signatures      match the failure to a known drift pattern   (pack-supplied)
   ├─ scorer          rank changed files + modules by relevance
   ├─ confidence      structured score + honesty caps + tier-gating
   └─ repairPlan      mode-gated, coding-agent-ready repair prompt
   ▼
DriftAnalysisReport  (cause, ranked files/modules, confidence, repair prompt)
```

### The `Pack` — the entire extensibility story

The engine imports nothing domain-specific. A `Pack` carries it all:

```ts
import { definePack } from "driftguard";

export const myPack = definePack({
  id: "my-product",
  signatures: [ /* how to recognise your drift patterns */ ],
  signatureToModules: { /* signature → modules it implicates */ },
  baseConstraints: [ /* do-not-break rules injected into every repair prompt */ ],
  scopeConstraints: { /* per-scope extra constraints */ },
  scopeImpact: { /* per-scope business impact copy */ },
  signatureGoals: { /* per-signature repair goal */ },
  signatureImpact: { /* per-signature impact */ },
  diffKeywords: [ /* domain words that align a diff to behaviour */ ],
  systemMap: { modules: [ /* your module responsibilities */ ] },
  locks: [ /* your behavioral invariants */ ],
});
```

Swap the pack, point it at a different product — zero engine changes. That is
the whole point of the standalone extraction.

## CLI

```bash
driftguard <pack.js> [--git <git-context.json>] [--prompts] [--emit <dir>]
```

Exits non-zero if any lock drifts or errors, so it gates CI. Pass a git context
(changed files since the last passing run) to lift confidence from "signature
heuristic" to "evidence-backed" and reveal ranked files.

## Bisection — find the culprit commit

The engine ships a real "git-bisect for AI behavior". Point it at a range and a
probe command (exit 0 = the lock passes); it binary-searches the commit that
introduced the regression and restores your working tree afterward:

```bash
driftguard bisect --range "main~30..main" \
  --command "npm run build --silent && node dist/src/cli.js dist/packs/demo-shop/pack.js"
```

```
  ✗ first failing commit: deadbeef…
    last good commit:    00aa11bb…
    probes evaluated:    5          # not 30 — ~log2(n)
```

A bisected culprit is the strongest causal evidence DriftGuard has: it lifts the
confidence cap and the precise commit range flows into the repair prompt.

## Coding-agent integration (the headline)

`--emit <dir>` writes, for each failing lock:

- `<lockKey>.repair.md` — the ready-to-run repair prompt
- `index.md` — a summary linking every repair
- `AGENT_RULES.md` — drop into `.cursor/rules/` or `CLAUDE.md` so any coding
  agent treats DriftGuard prompts safely (respect investigation mode, never edit
  locks to force a pass, re-run locks after changes)

Hand a prompt to Claude Code headlessly:

```bash
claude -p "$(cat .driftguard/shop.latest_intent_wins.repair.md)"
```

This is the wedge: most tools tell you a metric dropped. DriftGuard tells your
agent *what likely broke it* and *how to fix it safely* — and refuses to do so
overconfidently when the evidence isn't there.

## Roadmap to "elite"

1. **Deeper causality — built.** Execution traces, real bisection
   (`bisectFirstFailing`), and changed-watched-symbol analysis now feed an
   earned, three-tier confidence model. ✅
2. **Coding-agent integration — built.** `--emit` writes repair prompts +
   `AGENT_RULES`. ✅
3. **Bisection host adapter — built.** `driftguard bisect` / `runGitBisect`
   checks out real commits, runs a probe, and restores the tree. ✅
4. **Self-serve authoring** — locks/signatures/system-map as config, not only
   hand-written TypeScript. *(next)*
5. **Hosted cloud (open-core)** — run history, shared lock catalogues, CI
   dashboards, RBAC; the OSS core stays the distribution flywheel.

## License

MIT — see [LICENSE](./LICENSE).
