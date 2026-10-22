import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttestation, writeAttestation, defaultAttestationPath } from "../src/attest/attestation.js";
import { staleVerdictsDecision } from "../src/plugin/staleVerdicts.js";

function repo(verdict = "pass") {
  const root = mkdtempSync(join(tmpdir(), "sm-hook-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  const att = createAttestation({ root, subjects: ["src/a.ts"], verdict, by: "reviewer" });
  writeAttestation(defaultAttestationPath(join(root, ".slipmark/attestations"), att), att);
  return root;
}

test("stop hook: silent when every verdict still matches", () => {
  assert.equal(staleVerdictsDecision({ cwd: repo() }, "/"), null);
});

test("stop hook: silent on an honest fail verdict", () => {
  assert.equal(staleVerdictsDecision({ cwd: repo("fail") }, "/"), null);
});

test("stop hook: blocks once when an attested file changed", () => {
  const root = repo();
  writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
  const out = staleVerdictsDecision({ cwd: root }, "/");
  assert.ok(out);
  const d = JSON.parse(out!);
  assert.equal(d.decision, "block");
  assert.match(d.reason, /src\/a\.ts: changed after reviewer gave "pass"/);
  assert.equal(staleVerdictsDecision({ cwd: root, stop_hook_active: true }, "/"), null, "never blocks twice in a row");
});

test("stop hook: silent in a repo without Slipmark", () => {
  assert.equal(staleVerdictsDecision({ cwd: mkdtempSync(join(tmpdir(), "sm-none-")) }, "/"), null);
});
