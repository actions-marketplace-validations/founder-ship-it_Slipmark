# Concepts

The mental model behind Slipmark, in five ideas.

## 1. Lock

A **lock** is a codified behavioral invariant — a thing about your AI that must
stay true. "When the user pivots topic, the reply addresses the latest intent."
"Never quote a price for an item with no configured price."

A lock runs against a **synthetic fixture** (never real user data) and returns
`pass` or `drift` with the assertions that failed. Locks are deterministic: same
fixture, same result.

## 2. Pack

A **pack** carries all your domain knowledge — signatures, system map,
constraints, and locks. The engine imports nothing from your pack; it just
receives it. Swap the pack, point the engine at a different product. ReplyOS is
one pack; the e-commerce demo is another; yours is another.

This is what makes Slipmark a product and not a one-off script.

## 3. Signature

A **signature** is a named, recognisable class of drift ("stale intent
carryover", "ungrounded price invention"). When a lock fails, Slipmark matches
the failure against your pack's signature library to name *what kind* of thing
broke — which in turn points at the modules that class of bug usually lives in.

## 4. Earned confidence (the honesty model)

Slipmark refuses to present a guess as a fact. Confidence is gated by the
strength of the *causal evidence* available:

| Evidence | Confidence ceiling | Meaning |
|---|---|---|
| Signature / pattern only | **0.40** | A heuristic, not proof |
| + execution trace | **0.69** | The mechanism is known, not the commit |
| + git diff **or** bisected commit | **uncapped** | Linked to a specific change |

At low confidence, ranked files are **withheld** and the repair prompt switches
to *investigation mode* ("do not apply blind fixes"). Evidence sources:

- **Execution trace** — a lock records what it observed (modules/symbols
  exercised, observations like `intentSourceUsed="first"`).
- **Git diff** — files changed since the last passing run, ranked by ownership,
  keyword, and changed-symbol overlap.
- **Bisection** — the actual commit that flipped the behavior pass→fail.

## 5. Repair prompt

When a lock drifts, Slipmark emits a **mode-gated repair prompt** for a coding
agent:

- `suggest_patch` (high confidence) — propose concrete diffs, don't auto-apply.
- `minimal_fix` (medium) — smallest reversible change in the ranked area.
- `investigate_first` (low) — diagnose, don't patch.

Every prompt forbids editing the lock/fixtures to force a pass (anti-gaming) and
lists the locks to re-run for verification. This is the half most tools skip:
not just "a metric dropped", but "here's what likely broke it and how to fix it
safely".
