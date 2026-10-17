# Authoring guide

Two ways to author locks: **JSON** (no code) and **TypeScript** (full power).

---

## JSON packs (no code)

A JSON pack is the fastest way to protect an AI behavior. Slipmark runs your
**target command** with the fixture on stdin and asserts on its stdout.

```bash
slipmark ./drift.pack.json [--git <ctx.json>] [--prompts] [--emit <dir>]
```

### Minimal pack

```jsonc
{
  "id": "my-product",
  "locks": [
    {
      "key": "support.latest_intent_wins",
      "name": "Latest intent wins after a topic pivot",
      "scope": "ai",
      "invariants": ["When the user pivots topic, the reply addresses the latest intent."],
      "failureSignatures": ["stale_intent_carryover"],
      "watchedSymbols": ["composeReply"],
      "target": { "command": "node assistant.mjs", "inputFormat": "stdin-json" },
      "fixture": { "turns": [
        { "role": "user", "text": "I want to return an item" },
        { "role": "user", "text": "actually, track my order instead" }
      ] },
      "assertions": [
        { "name": "focuses_on_latest_intent", "type": "matches", "value": "track|delivery" },
        { "name": "no_prior_intent_carryover", "type": "not_matches", "value": "return|refund" }
      ],
      "driftMessage": "Reply carried a stale earlier intent (latest intent did not win)."
    }
  ]
}
```

### Targets

`target.command` runs once per lock with the fixture on stdin; **exit code is
ignored — assertions decide pass/drift.** stdout is the text asserted on.

| `inputFormat` | fixture is sent as |
|---|---|
| `stdin-json` (default) | `JSON.stringify(fixture)` on stdin |
| `stdin-text` | `String(fixture)` on stdin |

Commands run with the **pack file's directory** as the working directory, so a
pack can ship its own thin target script (any language).

Omit `target` entirely for **golden mode**: the `fixture` itself is treated as
the output to assert on (useful for testing recorded/golden outputs).

### Assertion types

| `type` | passes when output… |
|---|---|
| `contains` | contains the substring |
| `not_contains` | does not contain the substring |
| `matches` | matches the regex |
| `not_matches` | does not match the regex |
| `equals` | equals the value (trimmed) |
| `not_equals` | differs from the value |

All are case-insensitive by default; set `"ignoreCase": false` to make one
case-sensitive. Each assertion's `name` should match an `assertionName` in a
signature so failures get classified.

### Full pack fields

`id`, `locks` (required); optional: `signatures`, `signatureToModules`,
`baseConstraints`, `scopeConstraints`, `scopeImpact`, `signatureGoals`,
`signatureImpact`, `diffKeywords`, `systemMap`. See
`packs/demo-shop-declarative/drift.pack.json` for a complete example.

Signature `patterns` are regex source strings (`"latest\\s+intent"`), or
`"/pattern/flags"` form; default flag is `i`.

---

## TypeScript packs (full power)

Use TypeScript when you need arbitrary verification logic, in-process targets,
or self-instrumenting execution traces.

```ts
import { definePack, type LockDefinition } from "slipmark";

const latestIntentWins: LockDefinition = {
  key: "support.latest_intent_wins",
  name: "Latest intent wins",
  scope: "ai",
  invariants: ["Latest intent wins after a pivot."],
  likelyModules: ["intent_resolution", "reply_composer"],
  failureSignatures: ["stale_intent_carryover"],
  watchedSymbols: ["composeReply"],
  run() {
    const reply = composeReply(fixture);
    const ok = /track|delivery/i.test(reply);
    return {
      status: ok ? "pass" : "drift",
      message: ok ? "ok" : "latest intent did not win",
      failedAssertions: ok ? [] : [{ name: "focuses_on_latest_intent", reason: "addressed the wrong intent" }],
      // A good lock instruments itself — this lifts confidence honestly.
      trace: { modules: ["intent_resolution"], observations: { intentSourceUsed: "first" } },
    };
  },
};

export const myPack = definePack({ id: "my-product", /* ...signatures, systemMap... */ locks: [latestIntentWins] });
```

See `packs/demo-shop/` for a complete TypeScript pack.

---

## Wiring bisection (find the culprit commit)

```bash
slipmark bisect --range "main~30..main" \
  --command "npm run build --silent && node dist/src/cli.js dist/packs/demo-shop/pack.js"
```

The probe command's exit code decides pass/fail at each commit; Slipmark
binary-searches the first failing one and restores your working tree. A clean
working tree is required.
