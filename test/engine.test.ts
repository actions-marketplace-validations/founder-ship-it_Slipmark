import { test } from "node:test";
import assert from "node:assert/strict";
import { runPack, buildDriftAnalysisReport, resolveConfidenceTier } from "../src/index.js";
import type { GitContext, LockDefinition } from "../src/types.js";
import { demoShopPack } from "../packs/demo-shop/pack.js";

test("generalization: engine runs a non-ReplyOS pack and detects the planted regression", () => {
  const run = runPack(demoShopPack);
  assert.equal(run.packId, "demo-shop");
  assert.equal(run.total, 2);

  const intentLock = run.outcomes.find((o) => o.key === "shop.latest_intent_wins");
  const priceLock = run.outcomes.find((o) => o.key === "shop.no_invented_price");
  assert.ok(intentLock && priceLock);

  // The planted bug makes the intent lock drift; the price lock passes.
  assert.equal(intentLock!.result.status, "drift");
  assert.equal(priceLock!.result.status, "pass");
  assert.equal(run.drifted, 1);
  assert.equal(run.passed, 1);
});

test("diagnosis: the drift gets a signature match and a repair prompt", () => {
  const run = runPack(demoShopPack);
  const intentLock = run.outcomes.find((o) => o.key === "shop.latest_intent_wins")!;
  const analysis = intentLock.analysis!;
  assert.ok(analysis, "drifted lock must have analysis");

  // The right signature was recognised on a totally different domain.
  assert.ok(analysis.likelyFailureSignatures.includes("stale_intent_carryover"));
  // A repair prompt was produced and references the lock.
  assert.ok(analysis.repairPrompt && analysis.repairPrompt.includes("shop.latest_intent_wins"));
  // Modules from the pack's signature map were surfaced.
  assert.ok(analysis.rankedModules.some((m) => m.name === "intent_resolution"));
});

test("honesty: with no git diff, confidence is hard-capped at 0.40 (medium at best) and exposes no ranked files", () => {
  const run = runPack(demoShopPack); // no git context
  const analysis = run.outcomes.find((o) => o.key === "shop.latest_intent_wins")!.analysis!;

  // Strong signature but no diff/trace → capped at exactly 0.40 = medium tier (never high).
  assert.ok(analysis.confidence !== null);
  assert.ok(analysis.confidence! <= 0.4, `expected <=0.4, got ${analysis.confidence}`);
  assert.equal(analysis.confidenceTier, "medium");
  assert.ok(analysis.confidenceBreakdown!.capsApplied.includes("no_diff_no_trace_cap_0.40"));
  // No git diff means there are no files to rank — so none can be shown, regardless of tier.
  assert.equal(analysis.rankedFiles.length, 0, "without a diff there is nothing to rank");
  assert.equal(analysis.promptMode, "minimal_fix");
});

test("honesty: a failure with no recognised signal yields null confidence and forces investigation mode", () => {
  // No signature match + no diff = no signal at all. The engine must refuse to score it,
  // withhold ranked files, and tell the agent to diagnose rather than patch.
  const opaqueLock: LockDefinition = {
    key: "shop.opaque_failure",
    name: "Opaque failure with no known pattern",
    scope: "ai",
    invariants: ["Behaviour X must hold."],
    run: () => ({
      status: "drift",
      message: "an opaque value mismatch with no recognisable wording",
      failedAssertions: [{ name: "weird_unmatched_assertion", reason: "value mismatch" }],
    }),
  };

  const analysis = buildDriftAnalysisReport({
    pack: demoShopPack,
    lock: opaqueLock,
    registry: demoShopPack.locks,
    failedItem: {
      status: "drift",
      message: "an opaque value mismatch with no recognisable wording",
      failedAssertions: [{ name: "weird_unmatched_assertion", reason: "value mismatch" }],
    },
    gitContext: null,
  });

  assert.equal(analysis.confidence, null, "no signal must produce null confidence, not a fake number");
  assert.equal(analysis.confidenceTier, null);
  assert.equal(analysis.rankedFiles.length, 0);
  assert.equal(analysis.promptMode, "investigate_first");
  assert.match(analysis.repairPrompt!, /INVESTIGATION MODE/);
});

test("honesty: a real git diff overlapping ownership lifts confidence and reveals ranked files", () => {
  const gitContext: GitContext = {
    currentCommit: "abc1234567",
    lastPassingCommit: "def7654321",
    diffSummary: "changed intent selection in the reply composer",
    changedFiles: [
      {
        path: "packs/demo-shop/shopAssist.ts",
        changeType: "modified",
        additions: 6,
        deletions: 2,
        diffExcerpt: "const topicSource = first; // intent compose latest",
      },
    ],
  };
  const lock = demoShopPack.locks.find((l) => l.key === "shop.latest_intent_wins") as LockDefinition;
  const result = lock.run();
  const analysis = buildDriftAnalysisReport({
    pack: demoShopPack,
    lock,
    registry: demoShopPack.locks,
    failedItem: { status: "drift", message: result.message, failedAssertions: result.failedAssertions },
    gitContext,
  });

  assert.equal(analysis.analysisStatus, "ready");
  assert.ok(analysis.confidence! > 0.4, `expected >0.4 with diff, got ${analysis.confidence}`);
  const tier = resolveConfidenceTier(analysis.confidence);
  assert.ok(tier === "medium" || tier === "high");
  assert.ok(analysis.rankedFiles.length >= 1, "with a matching diff, ranked files should be exposed");
  assert.equal(analysis.rankedFiles[0]!.path, "packs/demo-shop/shopAssist.ts");
});
