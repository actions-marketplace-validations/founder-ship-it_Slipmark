import { test } from "node:test";
import assert from "node:assert/strict";
import { bisectFirstFailing, buildDriftAnalysisReport, resolveConfidenceTier } from "../src/index.js";
import type { BisectOutcome, GitContext, LockDefinition } from "../src/types.js";
import { demoShopPack } from "../packs/demo-shop/pack.js";

// ---- Bisection (the "git-bisect for AI behavior" algorithm) ----------------

test("bisect: finds the first failing commit in a monotonic history with ~log2(n) probes", async () => {
  const commits = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"]; // old → new
  const culprit = "c5"; // fails from c5 onward
  const order = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"];
  const isPassingAt = (c: string) => order.indexOf(c) < order.indexOf(culprit);

  const res = await bisectFirstFailing(commits, isPassingAt);
  assert.equal(res.firstFailingCommit, "c5");
  assert.equal(res.lastPassingCommit, "c4");
  assert.ok(res.evaluated <= 5, `expected ~log2(8) probes, got ${res.evaluated}`); // not 8
});

test("bisect: no regression when the newest commit still passes", async () => {
  const commits = ["a", "b", "c"];
  const res = await bisectFirstFailing(commits, () => true);
  assert.equal(res.firstFailingCommit, null);
  assert.equal(res.lastPassingCommit, "c");
});

test("bisect: regression predates the range when the oldest commit already fails", async () => {
  const commits = ["a", "b", "c"];
  const res = await bisectFirstFailing(commits, () => false);
  assert.equal(res.firstFailingCommit, "a");
  assert.equal(res.lastPassingCommit, null);
});

// ---- Three-tier honesty cap: no evidence at all → 0.40 ---------------------

test("honesty: a signature match with NO trace and NO diff is still capped at 0.40", () => {
  // A lock that does not instrument itself (no trace), failing with a pattern that
  // matches a signature but offering no causal evidence.
  const noTraceLock: LockDefinition = {
    key: "shop.no_trace_lock",
    name: "Lock without self-instrumentation",
    scope: "ai",
    invariants: ["Latest intent must win."],
    failureSignatures: ["stale_intent_carryover"],
    run: () => ({ status: "drift", message: "latest intent did not win", failedAssertions: [{ name: "focuses_on_latest_intent" }] }),
  };

  const analysis = buildDriftAnalysisReport({
    pack: demoShopPack,
    lock: noTraceLock,
    registry: demoShopPack.locks,
    failedItem: { status: "drift", message: "latest intent did not win", failedAssertions: [{ name: "focuses_on_latest_intent" }] },
    gitContext: null, // no diff, no trace, no bisect
  });

  assert.ok(analysis.confidence! <= 0.4, `expected <=0.40, got ${analysis.confidence}`);
  assert.ok(analysis.confidenceBreakdown!.capsApplied.includes("no_evidence_cap_0.40"));
});

// ---- Earned causal evidence lifts confidence and the prompt ----------------

test("causality: a bisected culprit + changed watched-symbol produce high confidence and a precise commit range", () => {
  const gitContext: GitContext = {
    diffSummary: "changed intent selection",
    changedFiles: [
      {
        path: "packs/demo-shop/shopAssist.ts",
        changeType: "modified",
        additions: 4,
        deletions: 1,
        // The diff excerpt declares a change to a watched symbol.
        diffExcerpt: "export function composeReply(turns) { const topicSource = first; }",
      },
    ],
  };
  const bisect: BisectOutcome = {
    firstFailingCommit: "deadbeefcafe",
    lastPassingCommit: "00aa11bb22cc",
    evaluated: 4,
  };

  const lock = demoShopPack.locks.find((l) => l.key === "shop.latest_intent_wins") as LockDefinition;
  const result = lock.run();
  const analysis = buildDriftAnalysisReport({
    pack: demoShopPack,
    lock,
    registry: demoShopPack.locks,
    failedItem: { status: "drift", message: result.message, failedAssertions: result.failedAssertions, trace: result.trace },
    gitContext,
    bisect,
  });

  // Watched symbol "composeReply" changed in the diff → earned evidence.
  assert.ok(analysis.changedWatchedSymbols.includes("composeReply"));
  assert.ok(analysis.confidenceBreakdown!.symbolMatch > 0);
  assert.ok(analysis.confidenceBreakdown!.bisectMatch > 0);
  // No cap applied (we have causal evidence) and confidence reaches high.
  assert.equal(analysis.confidenceBreakdown!.capsApplied.length, 0);
  assert.equal(resolveConfidenceTier(analysis.confidence), "high");
  // The commit range comes from bisection.
  assert.equal(analysis.currentGitCommit, "deadbeefcafe");
  assert.equal(analysis.previousPassingGitCommit, "00aa11bb22cc");
  // The prompt surfaces the causal evidence section.
  assert.match(analysis.repairPrompt!, /Causal evidence/);
  assert.match(analysis.repairPrompt!, /Bisected culprit commit/);
  assert.match(analysis.bisect ? "ok" : "", /ok/);
});
