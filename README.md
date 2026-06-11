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
repair**, and it is deliberately honest about certainty:

- **It refuses to fake precision.** Confidence is *hard-capped at 0.40* when there
  is no git diff and no execution trace — because a signature match is a heuristic,
  not proof. At low confidence it **withholds ranked files entirely** and flips
  into an explicit *investigation mode* ("do not apply blind fixes").
- **The repair prompt is mode-gated** — `suggest_patch` (high), `minimal_fix`
  (medium), `investigate_first` (low) — so an agent gets the right amount of rope.
- **Anti-gaming:** every prompt forbids editing the lock/fixtures to force a pass.

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
driftguard <pack.js> [--git <git-context.json>] [--prompts]
```

Exits non-zero if any lock drifts or errors, so it gates CI. Pass a git context
(changed files since the last passing run) to lift confidence from "signature
heuristic" to "evidence-backed" and reveal ranked files.

## Roadmap to "elite"

The framework and honesty model are in place. What earns the ranking next:

1. **Deeper causality** — wire the reserved execution-trace signal; add real
   bisection and semantic diff analysis so file ranking is demonstrated, not
   heuristically guessed.
2. **Self-serve authoring** — locks/signatures/system-map as config, not only
   hand-written TypeScript.
3. **Hosted cloud (open-core)** — run history, shared lock catalogues, CI
   dashboards, RBAC; the OSS core stays the distribution flywheel.
4. **First-class coding-agent integration** — Cursor / Claude Code repair-prompt
   hand-off as the headline.

## License

MIT — see [LICENSE](./LICENSE).
