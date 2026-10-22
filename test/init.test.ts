import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planInit, applyInit, upsertBlock, agentBlock, BLOCK_BEGIN, BLOCK_END } from "../src/init.js";

const REF = "v9.9.9";
const repo = () => mkdtempSync(join(tmpdir(), "sm-init-"));
const byPath = (plan: ReturnType<typeof planInit>) => Object.fromEntries(plan.map((f) => [f.path, f]));

test("init: a bare repo gets the directory, a report-only workflow and AGENTS.md", () => {
  const root = repo();
  const plan = planInit({ root, actionRef: REF });
  const p = byPath(plan);
  assert.equal(p[".slipmark/attestations/.gitkeep"]!.action, "create");
  assert.equal(p[".github/workflows/slipmark.yml"]!.action, "create");
  assert.equal(p["AGENTS.md"]!.action, "create");
  assert.equal(p["CLAUDE.md"], undefined, "CLAUDE.md is only touched when it already exists");
  applyInit(root, plan);
  const wf = readFileSync(join(root, ".github/workflows/slipmark.yml"), "utf8");
  assert.match(wf, /founder-ship-it\/Slipmark@v9\.9\.9/);
  assert.match(wf, /fail-on-refusal: "false"/, "a fresh repo has no attestations, so the gate must start report-only");
  assert.ok(existsSync(join(root, ".slipmark/attestations/.gitkeep")));
  assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /npx slipmark attest/);
});

test("init: running twice changes nothing the second time", () => {
  const root = repo();
  applyInit(root, planInit({ root, actionRef: REF }));
  const again = planInit({ root, actionRef: REF });
  assert.ok(again.every((f) => f.action === "skip"), JSON.stringify(again.map((f) => [f.path, f.action])));
});

test("init: existing CLAUDE.md and copilot instructions keep their content and gain the block once", () => {
  const root = repo();
  writeFileSync(join(root, "CLAUDE.md"), "# House rules\nUse pnpm.\n");
  mkdirSync(join(root, ".github"), { recursive: true });
  writeFileSync(join(root, ".github/copilot-instructions.md"), "Be brief.");
  applyInit(root, planInit({ root, actionRef: REF }));
  applyInit(root, planInit({ root, actionRef: REF }));
  const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.ok(claude.startsWith("# House rules\nUse pnpm.\n"));
  assert.equal(claude.split(BLOCK_BEGIN).length - 1, 1);
  const copilot = readFileSync(join(root, ".github/copilot-instructions.md"), "utf8");
  assert.ok(copilot.startsWith("Be brief.\n\n"));
  assert.equal(copilot.split(BLOCK_BEGIN).length - 1, 1);
});

test("init: a Claude Code project without CLAUDE.md gets one that imports AGENTS.md", () => {
  const root = repo();
  mkdirSync(join(root, ".claude"));
  applyInit(root, planInit({ root, actionRef: REF }));
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  // Second run: CLAUDE.md imports AGENTS.md, so the block is not duplicated into it.
  const again = byPath(planInit({ root, actionRef: REF }));
  assert.equal(again["CLAUDE.md"]!.action, "skip");
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
});

test("init: a Cursor project gets a rule file", () => {
  const root = repo();
  mkdirSync(join(root, ".cursor"));
  const p = byPath(planInit({ root, actionRef: REF }));
  assert.equal(p[".cursor/rules/slipmark.mdc"]!.action, "create");
  assert.match(p[".cursor/rules/slipmark.mdc"]!.content, /alwaysApply: true/);
});

test("init: never overwrites a workflow the user wrote, unless forced", () => {
  const root = repo();
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/slipmark.yml"), "name: mine\n");
  assert.equal(byPath(planInit({ root, actionRef: REF }))[".github/workflows/slipmark.yml"]!.action, "skip");
  assert.equal(byPath(planInit({ root, actionRef: REF, force: true }))[".github/workflows/slipmark.yml"]!.action, "update");
});

test("init: a workflow init wrote earlier is refreshed to the new Action version", () => {
  const root = repo();
  applyInit(root, planInit({ root, actionRef: "v0.3.0" }));
  const p = byPath(planInit({ root, actionRef: "v0.4.0" }));
  assert.equal(p[".github/workflows/slipmark.yml"]!.action, "update");
  assert.match(p[".github/workflows/slipmark.yml"]!.content, /@v0\.4\.0/);
});

test("init: --no-workflow and --no-agents are respected", () => {
  const root = repo();
  const plan = planInit({ root, actionRef: REF, workflow: false, agents: false });
  assert.deepEqual(plan.map((f) => f.path), [".slipmark/attestations/.gitkeep"]);
});

test("upsertBlock: replaces an outdated block in place and keeps what surrounds it", () => {
  const old = `intro\n\n${BLOCK_BEGIN}\nold rules\n${BLOCK_END}\nafter\n`;
  const next = upsertBlock(old, agentBlock())!;
  assert.ok(next.startsWith("intro\n\n" + BLOCK_BEGIN));
  assert.ok(next.endsWith("after\n"));
  assert.ok(!next.includes("old rules"));
  assert.equal(upsertBlock(next, agentBlock()), null, "no change when already current");
});
