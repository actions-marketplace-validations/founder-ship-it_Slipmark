import { test } from "node:test";
import assert from "node:assert/strict";
import { runPack, repairArtifactsFor, repairIndexDoc, agentRulesDoc, claudeCodeCommandFor } from "../src/index.js";
import { demoShopPack } from "../packs/demo-shop/pack.js";

test("coding-agent: a drift produces a repair artifact for the failing lock", () => {
  const run = runPack(demoShopPack);
  const artifacts = repairArtifactsFor(run);

  // Exactly one drift in the demo → one artifact; the passing lock produces none.
  assert.equal(artifacts.length, 1);
  const a = artifacts[0]!;
  assert.equal(a.lockKey, "shop.latest_intent_wins");
  assert.equal(a.filename, "shop.latest_intent_wins.repair.md");
  assert.match(a.content, /Slipmark repair prompt/);
  assert.ok(a.promptMode.length > 0);
});

test("coding-agent: the index doc links every artifact", () => {
  const run = runPack(demoShopPack);
  const artifacts = repairArtifactsFor(run);
  const index = repairIndexDoc(run, artifacts);
  assert.match(index, /pack `demo-shop`/);
  assert.match(index, /shop\.latest_intent_wins\.repair\.md/);
});

test("coding-agent: the rules doc encodes the non-negotiable safety rails", () => {
  const rules = agentRulesDoc();
  assert.match(rules, /investigate_first/);
  assert.match(rules, /Never edit Slipmark locks/i);
  assert.match(rules, /re-run the locks/i);
});

test("coding-agent: the Claude Code invocation helper is shaped correctly", () => {
  const cmd = claudeCodeCommandFor(".slipmark/shop.latest_intent_wins.repair.md");
  assert.equal(cmd, 'claude -p "$(cat .slipmark/shop.latest_intent_wins.repair.md)"');
});
