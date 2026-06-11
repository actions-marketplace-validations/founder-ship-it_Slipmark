#!/usr/bin/env node
/**
 * Minimal DriftGuard CLI.
 *
 *   driftguard <pack.ts|pack.js> [--git <git-context.json>] [--prompts]
 *
 * Loads a pack module (default export OR a named *Pack export), runs every lock,
 * prints a summary, and (with --prompts) prints the repair prompt for each drift.
 *
 * Exit code is non-zero if any lock drifts or errors — so it gates CI.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { runPack, repairArtifactsFor, repairIndexDoc, agentRulesDoc, claudeCodeCommandFor, runGitBisect, loadDeclarativePack, summariseRun, appendRun, renderDashboardHtml } from "./index.js";
import type { GitContext, Pack } from "./types.js";
import type { VerificationRun } from "./engine/runner.js";
import type { DashboardData } from "./dashboard/data.js";
import { existsSync } from "node:fs";

function fail(msg: string): never {
  console.error(`driftguard: ${msg}`);
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

/** `driftguard bisect --range <range> --command <cmd> [--cwd <dir>]` */
async function bisectMain(args: string[]): Promise<void> {
  const range = argVal(args, "--range");
  const command = argVal(args, "--command");
  const cwd = argVal(args, "--cwd") ?? process.cwd();
  if (!range || !command) {
    fail('usage: driftguard bisect --range <git-range> --command "<probe cmd, exit 0 = pass>" [--cwd <dir>]');
  }
  console.log(`\nDriftGuard bisect — range \`${range}\`\n  probe: ${command}\n`);
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
 * `driftguard dashboard <pack> [--git f] [--history h.json] [--project name] --out file.html`
 * or render existing history: `driftguard dashboard --from h.json --out file.html`
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
    if (!packPath) fail("usage: driftguard dashboard <pack> [--history h.json] --out f.html  |  driftguard dashboard --from h.json --out f.html");
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

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "bisect") {
    await bisectMain(args.slice(1));
    return;
  }
  if (args[0] === "dashboard") {
    await dashboardMain(args.slice(1));
    return;
  }

  const packPath = args.find((a) => !a.startsWith("--"));
  if (!packPath) fail("usage: driftguard <pack> [--git <file.json>] [--prompts] [--emit <dir>]  |  driftguard bisect --range <r> --command <cmd>");

  const gitIdx = args.indexOf("--git");
  const gitPath = gitIdx >= 0 ? (args[gitIdx + 1] ?? null) : null;
  const showPrompts = args.includes("--prompts");
  const emitIdx = args.indexOf("--emit");
  const emitDir = emitIdx >= 0 ? (args[emitIdx + 1] ?? null) : null;

  const pack = await loadPack(packPath!);
  const run = runPack(pack, loadGit(gitPath));

  console.log(`\nDriftGuard — pack \`${run.packId}\``);
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
