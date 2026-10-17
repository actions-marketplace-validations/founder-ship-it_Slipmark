import { test } from "node:test";
import assert from "node:assert/strict";
import { runPack, summariseRun, appendRun, renderDashboardHtml } from "../src/index.js";
import type { DashboardData } from "../src/dashboard/data.js";
import { demoShopPack } from "../packs/demo-shop/pack.js";

test("dashboard: summariseRun captures counts and per-lock status", () => {
  const run = runPack(demoShopPack);
  const summary = summariseRun(run, { project: "demo", timestamp: "2026-06-11T00:00:00.000Z" });
  assert.equal(summary.packId, "demo-shop");
  assert.equal(summary.drifted, 1);
  assert.equal(summary.passed, 1);
  const drift = summary.locks.find((l) => l.key === "shop.latest_intent_wins")!;
  assert.equal(drift.status, "drift");
  assert.ok(drift.repairPrompt, "drifted lock carries its repair prompt for drill-down");
});

test("dashboard: appendRun keeps newest first and caps length", () => {
  const r1 = summariseRun(runPack(demoShopPack), { timestamp: "2026-06-10T00:00:00.000Z" });
  const r2 = summariseRun(runPack(demoShopPack), { timestamp: "2026-06-11T00:00:00.000Z" });
  const h1 = appendRun(null, r1, "demo");
  const h2 = appendRun(h1, r2, "demo");
  assert.equal(h2.runs.length, 2);
  assert.equal(h2.runs[0]!.timestamp, "2026-06-11T00:00:00.000Z"); // newest first
});

test("dashboard: renders self-contained HTML and escapes untrusted content", () => {
  const data: DashboardData = {
    project: "my-product",
    generatedAt: "2026-06-11T00:00:00.000Z",
    runs: [
      {
        id: "r1",
        timestamp: "2026-06-11T00:00:00.000Z",
        packId: "p",
        total: 1,
        passed: 0,
        drifted: 1,
        errored: 0,
        locks: [
          {
            key: "x.lock",
            name: "X",
            scope: "ai",
            status: "drift",
            confidence: 0.86,
            confidenceTier: "high",
            severity: "high",
            signatures: ["stale_intent_carryover"],
            confidenceExplanation: "Confidence is high because …",
            repairPrompt: "do the thing <script>alert(1)</script> end",
          },
        ],
      },
    ],
  };
  const html = renderDashboardHtml(data);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /my-product/);
  assert.match(html, /x\.lock/);
  assert.match(html, /Slipmark/);
  // Untrusted repair-prompt content must be escaped, not injected raw.
  assert.ok(!html.includes("<script>alert(1)"), "must not inject raw script");
  assert.match(html, /&lt;script&gt;alert\(1\)/);
});
