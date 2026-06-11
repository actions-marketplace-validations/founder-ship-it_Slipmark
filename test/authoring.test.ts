import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  compileDeclarativePack,
  evaluateAssertions,
  loadDeclarativePack,
  runPack,
  type DeclarativePack,
} from "../src/index.js";

// ---- Pure assertion evaluation (no spawning) -------------------------------

test("authoring: assertion types evaluate correctly", () => {
  const out = "I can help you track your order";
  assert.equal(evaluateAssertions(out, [{ name: "a", type: "contains", value: "track" }]).length, 0);
  assert.equal(evaluateAssertions(out, [{ name: "a", type: "not_contains", value: "refund" }]).length, 0);
  assert.equal(evaluateAssertions(out, [{ name: "a", type: "matches", value: "track|delivery" }]).length, 0);
  // A failing assertion is reported with a reason.
  const failed = evaluateAssertions(out, [{ name: "wants_refund", type: "contains", value: "refund" }]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.name, "wants_refund");
  assert.match(failed[0]!.reason!, /Expected output to contain/);
});

// ---- Pure compiler with an injected (no-spawn) target runner ---------------

test("authoring: a declarative pack compiles and runs via an injected target runner", () => {
  const decl: DeclarativePack = {
    id: "inline",
    locks: [
      {
        key: "x.latest_wins",
        name: "latest wins",
        scope: "ai",
        invariants: ["latest intent wins"],
        failureSignatures: ["stale_intent_carryover"],
        assertions: [{ name: "focuses_on_latest_intent", type: "matches", value: "track" }],
        fixture: { turns: [] },
        driftMessage: "stale intent carried over",
      },
    ],
    signatures: [
      {
        key: "stale_intent_carryover",
        label: "Stale intent",
        description: "earlier topic carried over",
        assertionNames: ["focuses_on_latest_intent"],
        patterns: ["latest\\s+intent"],
      },
    ],
  };
  // Target runner returns a buggy reply (about returns, not tracking) → drift.
  const pack = compileDeclarativePack(decl, () => "I can help with your return");
  const run = runPack(pack);
  const outcome = run.outcomes[0]!;
  assert.equal(outcome.result.status, "drift");
  assert.ok(outcome.analysis!.likelyFailureSignatures.includes("stale_intent_carryover"));
});

// ---- End-to-end: a real JSON pack + a real target command ------------------

test("self-serve: a config-only JSON pack with a target command detects the planted drift", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // Source path (the .mjs target lives next to the .json), not dist.
  const packPath = join(here, "..", "..", "packs", "demo-shop-declarative", "drift.pack.json");
  const pack = loadDeclarativePack(packPath);
  assert.equal(pack.id, "demo-shop-declarative");

  const run = runPack(pack);
  const lock = run.outcomes.find((o) => o.key === "shop.latest_intent_wins")!;
  assert.equal(lock.result.status, "drift", "the planted bug in assistant.mjs should be caught");
  assert.ok(lock.analysis, "drift should produce analysis");
  assert.ok(lock.analysis!.likelyFailureSignatures.includes("stale_intent_carryover"));
  assert.ok(lock.analysis!.repairPrompt && lock.analysis!.repairPrompt.includes("shop.latest_intent_wins"));
});
