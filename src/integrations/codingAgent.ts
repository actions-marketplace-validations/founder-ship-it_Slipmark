/**
 * Coding-agent integration.
 *
 * DriftGuard's headline differentiator: when a lock drifts, hand a coding agent
 * (Cursor, Claude Code, Copilot, etc.) a ready-to-run repair prompt — and the
 * guard rails for how to act on it safely.
 *
 * This module emits artifacts; it never invokes an agent or edits code itself.
 */
import type { VerificationRun } from "../engine/runner.js";

export interface RepairArtifact {
  lockKey: string;
  /** Relative filename, e.g. "shop.latest_intent_wins.repair.md". */
  filename: string;
  content: string;
  promptMode: string;
  confidenceTier: string | null;
}

/** One repair artifact per drifted/errored lock that produced a prompt. */
export function repairArtifactsFor(run: VerificationRun): RepairArtifact[] {
  const artifacts: RepairArtifact[] = [];
  for (const o of run.outcomes) {
    if (!o.analysis || !o.analysis.repairPrompt) continue;
    if (o.result.status !== "drift" && o.result.status !== "error") continue;
    artifacts.push({
      lockKey: o.key,
      filename: `${o.key}.repair.md`,
      content: o.analysis.repairPrompt,
      promptMode: o.analysis.promptMode,
      confidenceTier: o.analysis.confidenceTier,
    });
  }
  return artifacts;
}

/** An index file linking all repair artifacts in a run. */
export function repairIndexDoc(run: VerificationRun, artifacts: RepairArtifact[]): string {
  const lines = [
    `# DriftGuard repairs — pack \`${run.packId}\``,
    "",
    `${run.passed} passed · ${run.drifted} drifted · ${run.errored} errored (of ${run.total}).`,
    "",
  ];
  if (artifacts.length === 0) {
    lines.push("No drift — nothing to repair. ✅");
  } else {
    lines.push("Open the repair prompt for each failing lock and hand it to your coding agent:");
    lines.push("");
    for (const a of artifacts) {
      lines.push(
        `- [\`${a.lockKey}\`](./${a.filename}) — mode \`${a.promptMode}\`, confidence \`${a.confidenceTier ?? "n/a"}\``,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Shell command to feed a repair prompt to Claude Code headlessly. */
export function claudeCodeCommandFor(promptPath: string): string {
  return `claude -p "$(cat ${promptPath})"`;
}

/**
 * A rules doc to drop into a repo (e.g. `.cursor/rules/driftguard.md` or
 * `CLAUDE.md`) so any coding agent treats DriftGuard repair prompts safely.
 * Encodes the non-negotiables that make DriftGuard trustworthy.
 */
export function agentRulesDoc(): string {
  return [
    "# DriftGuard — rules for coding agents",
    "",
    "When you are given a file named `*.repair.md` produced by DriftGuard, follow these rules:",
    "",
    "1. **Respect the declared mode.**",
    "   - `investigate_first` (low confidence): DO NOT edit product code. Produce a diagnosis,",
    "     not a patch. Ranked files are intentionally withheld — do not invent them.",
    "   - `minimal_fix` (medium): apply the smallest reversible change in the top-ranked area only.",
    "   - `suggest_patch` (high): you may propose concrete diffs, but do not auto-apply them.",
    "2. **Never edit DriftGuard locks, fixtures, or assertions to make a failing lock pass.**",
    "   That is gaming the test, not fixing the bug.",
    "3. **Stay inside the ranked likely-cause area.** Do not refactor unrelated modules.",
    "4. **Treat anything labelled 'likely' / 'probable' / 'inferred' as a hypothesis** — confirm",
    "   with evidence before trusting it.",
    "5. **After any change, re-run the locks listed under 'Verification — rerun locks'.** Each must",
    "   return status `pass`. If they do not, revert rather than patching further blindly.",
    "6. **Honour the confidence signal.** Low confidence means the evidence is weak — ask for a",
    "   git diff or a follow-up analysis run before editing, rather than guessing.",
    "",
  ].join("\n");
}
