#!/usr/bin/env node
/**
 * Minimal Slipmark CLI.
 *
 *   slipmark init [--dry-run] [--no-workflow] [--no-agents] [--force]
 *   slipmark <pack.ts|pack.js> [--git <git-context.json>] [--prompts]
 *   slipmark attest --by <agent> --verdict <pass|fail> --subject <file> [--subject <file>...] [--note "..."] [--out <file>]
 *   slipmark verify [--dir .slipmark/attestations] [--require <file>...] [--json]
 *
 * Loads a pack module (default export OR a named *Pack export), runs every lock,
 * prints a summary, and (with --prompts) prints the repair prompt for each drift.
 *
 * Exit code is non-zero if any lock drifts or errors — so it gates CI.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, join, relative } from "node:path";
import { runPack, repairArtifactsFor, repairIndexDoc, agentRulesDoc, claudeCodeCommandFor, runGitBisect, loadDeclarativePack, summariseRun, appendRun, renderDashboardHtml } from "./index.js";
import type { GitContext, Pack } from "./types.js";
import type { VerificationRun } from "./engine/runner.js";
import type { DashboardData } from "./dashboard/data.js";
import { createAttestation, writeAttestation, defaultAttestationPath, verifyAttestations } from "./attest/attestation.js";
import { existsSync } from "node:fs";
import { planInit, applyInit } from "./init.js";

/** Version from the package this CLI ships in (dist/src/cli.js → ../../package.json). */
function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

const HELP = `Slipmark: make AI agents prove what they checked.

Usage
  slipmark init                 Wire Slipmark into this repo (workflow + agent instructions)
  slipmark attest ...           Record a verdict bound to the SHA-256 of the files it covers
  slipmark verify               Refuse if any verdict is about different files from these
  slipmark <pack>               Run drift diagnosis locks
  slipmark bisect ...           Find the commit where a probe started failing
  slipmark dashboard ...        Render a drift history dashboard

attest
  --by <agent> --verdict <pass|cleared|fail|blocked> --subject <file> [--subject <file>...]
  [--note "..."] [--dir .slipmark/attestations] [--out <file>]

verify
  [--dir .slipmark/attestations] [--require <file>...] [--json]
  Exit 0: every verdict matches the files as they are now. Exit 1: refused.

init
  [--dry-run] [--no-workflow] [--no-agents] [--force]

Docs: https://github.com/founder-ship-it/Slipmark
`;

/** `slipmark init [--dry-run] [--no-workflow] [--no-agents] [--force]` */
function initMain(args: string[]): void {
  const root = process.cwd();
  const plan = planInit({
    root,
    actionRef: `v${version()}`,
    workflow: !args.includes("--no-workflow"),
    agents: !args.includes("--no-agents"),
    force: args.includes("--force"),
  });
  const dry = args.includes("--dry-run");
  console.log(`\nSlipmark init${dry ? " (dry run, nothing written)" : ""}\n`);
  for (const f of plan) {
    const mark = f.action === "skip" ? "·" : f.action === "create" ? "+" : "~";
    console.log(`  ${mark} ${f.action.padEnd(6)} ${f.path.padEnd(36)} ${f.reason}`);
  }
  if (dry) return;
  applyInit(root, plan);
  console.log(`
  Next
    1. Commit these files, including .slipmark/attestations/.
    2. Your agents now attest verdicts with: npx slipmark attest --by <role> --verdict pass --subject <file>
    3. Check any time with: npx slipmark verify
    4. The workflow starts in report-only mode. Set fail-on-refusal to "true" to enforce.
`);
}

function fail(msg: string): never {
  console.error(`slipmark: ${msg}`);
  process.exit(2);
}

async function loadPack(modPath: string): Promise<Pack> {
  // Declarative JSON pack → no code required.
  if (modPath.endsWith(".json")) return loadDeclarativePack(modPath);

  const url = pathToFileURL(resolve(modPath)).href;
  const mod = (await import(url)) as Record<string, unknown>;
  const candidate =
    (mod.default as Pack | undefined) ??
    (Object.values(mod).find(
      (v) => v && typeof v === "object" && "id" in (v as object) && "locks" in (v as object),
    ) as Pack | undefined);
  if (!candidate) fail(`no Pack export found in ${modPath}`);
  return candidate;
}

function loadGit(path: string | null): GitContext | null {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8")) as GitContext;
  } catch (e) {
    fail(`could not read git context ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function argVal(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

/** `slipmark bisect --range <range> --command <cmd> [--cwd <dir>]` */
async function bisectMain(args: string[]): Promise<void> {
  const range = argVal(args, "--range");
  const command = argVal(args, "--command");
  const cwd = argVal(args, "--cwd") ?? process.cwd();
  if (!range || !command) {
    fail('usage: slipmark bisect --range <git-range> --command "<probe cmd, exit 0 = pass>" [--cwd <dir>]');
  }
  console.log(`\nSlipmark bisect — range \`${range}\`\n  probe: ${command}\n`);
  const result = await runGitBisect({ cwd, range: range!, command: command! });
  if (!result.firstFailingCommit) {
    console.log(`  ✓ no regression in this range (newest commit still passes). ${result.evaluated} probes.\n`);
    process.exit(0);
  }
  console.log(`  ✗ first failing commit: ${result.firstFailingCommit}`);
  console.log(`    last good commit:    ${result.lastPassingCommit ?? "(regression predates range)"}`);
  console.log(`    probes evaluated:    ${result.evaluated}\n`);
  process.exit(1);
}

/**
 * `slipmark dashboard <pack> [--git f] [--history h.json] [--project name] --out file.html`
 * or render existing history: `slipmark dashboard --from h.json --out file.html`
 */
async function dashboardMain(args: string[]): Promise<void> {
  const out = argVal(args, "--out") ?? "dashboard.html";
  const from = argVal(args, "--from");
  const project = argVal(args, "--project");

  let data: DashboardData;
  if (from) {
    data = JSON.parse(readFileSync(resolve(from), "utf8")) as DashboardData;
  } else {
    const packPath = args.find((a) => !a.startsWith("--"));
    if (!packPath) fail("usage: slipmark dashboard <pack> [--history h.json] --out f.html  |  slipmark dashboard --from h.json --out f.html");
    const pack = await loadPack(packPath!);
    const run = runPack(pack, loadGit(argVal(args, "--git")));
    const summary = summariseRun(run, { project: project ?? pack.id });

    const historyPath = argVal(args, "--history");
    const prior =
      historyPath && existsSync(resolve(historyPath))
        ? (JSON.parse(readFileSync(resolve(historyPath), "utf8")) as DashboardData)
        : null;
    data = appendRun(prior, summary, project ?? pack.id);
    // Persist the history file — this flat file IS the "backend" today.
    if (historyPath) writeFileSync(resolve(historyPath), JSON.stringify(data, null, 2), "utf8");
  }

  writeFileSync(resolve(out), renderDashboardHtml(data), "utf8");
  console.log(`\n  dashboard written → ${out}  (${data.runs.length} run(s))`);
  console.log(`  open it: file://${resolve(out)}\n`);
}

function argVals(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag && args[i + 1] !== undefined) out.push(args[i + 1]!);
  });
  return out;
}

/** `slipmark attest --by <agent> --verdict <v> --subject <file>... [--note t] [--out f] [--dir d]` */
function attestMain(args: string[]): void {
  const by = argVal(args, "--by");
  const verdict = argVal(args, "--verdict");
  const subjects = argVals(args, "--subject");
  if (!by || !verdict || subjects.length === 0) {
    fail('usage: slipmark attest --by <agent> --verdict <pass|fail> --subject <file> [--subject <file>...] [--note "..."] [--out <file>]');
  }
  const att = createAttestation({ by: by!, verdict: verdict!, subjects, note: argVal(args, "--note") ?? undefined });
  const dir = resolve(argVal(args, "--dir") ?? ".slipmark/attestations");
  const out = argVal(args, "--out") ? resolve(argVal(args, "--out")!) : defaultAttestationPath(dir, att);
  writeAttestation(out, att);
  console.log(`\n  ${att.by} → "${att.verdict}" on ${att.subjects.length} file(s)`);
  for (const s of att.subjects) console.log(`    ${s.sha256.slice(0, 12)}  ${s.path}`);
  console.log(`  written → ${relative(process.cwd(), out)}\n`);
}

/** `slipmark verify [--dir d] [--require <file>...] [--json]` */
function verifyMain(args: string[]): void {
  const report = verifyAttestations({
    dir: argVal(args, "--dir") ?? undefined,
    require: argVals(args, "--require"),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }
  const passed = report.results.filter((r) => r.status === "verified").length;
  console.log(`\nSlipmark verify: ${passed} verified · ${report.failures.length} refused\n`);
  for (const r of report.results) {
    const icon = r.status === "verified" ? "✓" : "✗";
    console.log(`  ${icon} ${r.status.padEnd(20)} ${r.message}`);
    if (r.status === "hash_mismatch") {
      console.log(`      attested: ${r.expected}`);
      console.log(`      now:      ${r.actual}`);
    }
  }
  if (report.ok) console.log("\n  Every verdict matches the files as they are now.\n");
  else if (report.checked === 0)
    console.log(
      "\n  Gate refused: no verdicts recorded yet, so there is nothing to prove.\n" +
        "  Agents record one with: npx slipmark attest --by <role> --verdict pass --subject <file>\n" +
        "  New here? Run: npx slipmark init\n",
    );
  else console.log("\n  Gate refused. Re-run the agent on the current files, or fix the input.\n");
  process.exit(report.ok ? 0 : 1);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return;
  }
  if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
    console.log(version());
    return;
  }
  if (args[0] === "init") {
    initMain(args.slice(1));
    return;
  }
  if (args[0] === "bisect") {
    await bisectMain(args.slice(1));
    return;
  }
  if (args[0] === "attest") {
    attestMain(args.slice(1));
    return;
  }
  if (args[0] === "verify") {
    verifyMain(args.slice(1));
    return;
  }
  if (args[0] === "dashboard") {
    await dashboardMain(args.slice(1));
    return;
  }

  const packPath = args.find((a) => !a.startsWith("--"));
  if (!packPath) fail("usage: slipmark <pack> [--git <file.json>] [--prompts] [--emit <dir>]  |  slipmark verify  |  slipmark attest ...  |  slipmark bisect --range <r> --command <cmd>");

  const gitIdx = args.indexOf("--git");
  const gitPath = gitIdx >= 0 ? (args[gitIdx + 1] ?? null) : null;
  const showPrompts = args.includes("--prompts");
  const emitIdx = args.indexOf("--emit");
  const emitDir = emitIdx >= 0 ? (args[emitIdx + 1] ?? null) : null;

  const pack = await loadPack(packPath!);
  const run = runPack(pack, loadGit(gitPath));

  console.log(`\nSlipmark — pack \`${run.packId}\``);
  console.log(`  ${run.passed} passed · ${run.drifted} drifted · ${run.errored} errored (of ${run.total})\n`);

  for (const o of run.outcomes) {
    const icon = o.result.status === "pass" ? "✓" : o.result.status === "drift" ? "✗" : "!";
    console.log(`  ${icon} ${o.key} — ${o.result.status}`);
    if (o.analysis) {
      const a = o.analysis;
      console.log(`      cause: ${a.likelyCauseSummary}`);
      console.log(`      confidence: ${a.confidenceTier ?? "n/a"}${typeof a.confidence === "number" ? ` (${(a.confidence * 100).toFixed(0)}%)` : ""} · severity: ${a.severity} · mode: ${a.promptMode}`);
      if (showPrompts && a.repairPrompt) {
        console.log("\n----- repair prompt -----\n");
        console.log(a.repairPrompt);
        console.log("\n----- end prompt -----\n");
      }
    }
  }

  if (emitDir) emitArtifacts(run, emitDir);

  process.exit(run.drifted > 0 || run.errored > 0 ? 1 : 0);
}

/** Write per-lock repair prompts, an index, and the coding-agent rules doc. */
function emitArtifacts(run: VerificationRun, dir: string): void {
  const outDir = resolve(dir);
  mkdirSync(outDir, { recursive: true });
  const artifacts = repairArtifactsFor(run);
  for (const a of artifacts) {
    writeFileSync(join(outDir, a.filename), a.content, "utf8");
  }
  writeFileSync(join(outDir, "index.md"), repairIndexDoc(run, artifacts), "utf8");
  writeFileSync(join(outDir, "AGENT_RULES.md"), agentRulesDoc(), "utf8");

  console.log(`\n  emitted ${artifacts.length} repair prompt(s) to ${outDir}`);
  for (const a of artifacts) {
    console.log(`    → ${join(dir, a.filename)}`);
    console.log(`      hand to Claude Code:  ${claudeCodeCommandFor(join(dir, a.filename))}`);
  }
  console.log(`    → ${join(dir, "AGENT_RULES.md")} (drop into .cursor/rules or CLAUDE.md)\n`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
