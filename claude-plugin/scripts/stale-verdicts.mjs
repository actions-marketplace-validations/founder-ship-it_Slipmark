#!/usr/bin/env node
/**
 * Slipmark Stop hook for Claude Code.
 *
 * When Claude finishes a turn, re-check the repo's attestations. If any verdict
 * has gone stale (a file changed or vanished after it was attested), block the
 * stop once and tell Claude which ones, so it re-reads and attests again before
 * handing over. Never blocks on an honest "fail" verdict, never blocks twice in
 * a row (stop_hook_active), and stays silent in repos that don't use Slipmark.
 *
 * Pure Node, no dependencies: it shells out to `npx slipmark@0.3.0 verify --json` (pinned).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  /* no stdin: treat as a plain run */
}

// Claude already continued once because of this hook: let it stop.
if (input.stop_hook_active) process.exit(0);

const root = input.cwd || process.cwd();
const dir = join(root, ".slipmark", "attestations");
if (!existsSync(dir)) process.exit(0);

const run = spawnSync("npx", ["--yes", "slipmark@0.3.0", "verify", "--json"], {
  cwd: root,
  encoding: "utf8",
  timeout: 60_000,
});
if (run.error || !run.stdout) process.exit(0); // never get in the way if the check can't run

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  process.exit(0);
}

const STALE = new Set(["hash_mismatch", "subject_missing"]);
const stale = (report.results || []).filter((r) => STALE.has(r.status));
if (stale.length === 0) process.exit(0);

const lines = stale.map((r) =>
  r.status === "hash_mismatch"
    ? `- ${r.subject}: changed after ${r.by} gave "${r.verdict}"`
    : `- ${r.subject}: attested by ${r.by} but no longer exists`,
);

const reason = [
  `Slipmark: ${stale.length} verdict(s) no longer match the files.`,
  ...lines,
  "",
  "If you changed these files, read them again and re-attest with `npx slipmark@0.3.0 attest` (fail if they no longer pass).",
  "If the change was not yours, say so in your reply instead of re-attesting.",
].join("\n");

process.stdout.write(JSON.stringify({ decision: "block", reason }));
process.exit(0);
