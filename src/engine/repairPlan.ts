/**
 * Repair plan + coding-agent repair-prompt generator (domain-agnostic).
 *
 * Outputs are human/agent-readable guidance only. This module NEVER edits code.
 * All domain-specific constraint/impact/goal copy comes from the Pack.
 */
import type {
  ChangedFile,
  ConfidenceTier,
  FailedAssertion,
  FailureSignatureMatch,
  LockDefinition,
  Pack,
  PromptMode,
  RankedFile,
  RankedModule,
  RepairPlan,
  DriftSeverity,
  AnalysisStatus,
} from "../types.js";
import { resolveConfidenceTier } from "./confidence.js";

export function resolvePromptMode(confidence: number | null): PromptMode {
  const tier = resolveConfidenceTier(confidence);
  if (tier === "high") return "suggest_patch";
  if (tier === "medium") return "minimal_fix";
  return "investigate_first";
}

export function resolveSeverity(
  lock: LockDefinition,
  matches: FailureSignatureMatch[],
  analysisError: boolean,
): DriftSeverity {
  if (analysisError) return "medium";
  // A pack can mark tenancy/auth/billing scopes critical via naming convention.
  if (lock.scope === "tenancy" || lock.scope === "billing") return "critical";
  if (matches.some((m) => /auth|tenant|rls|boundary/i.test(m.key))) return "critical";
  if (lock.scope === "ai" || lock.scope === "messaging") return "high";
  return "medium";
}

function modeHeadline(mode: PromptMode): string {
  switch (mode) {
    case "suggest_patch":
      return "High-confidence analysis — you may propose concrete diffs for review. Do not auto-apply them.";
    case "minimal_fix":
      return "Medium-confidence analysis — apply the smallest safe targeted fix within the ranked area.";
    case "investigate_first":
    default:
      return "Low-confidence analysis — investigate and diagnose before making any code change.";
  }
}

function behaviouralRequirements(mode: PromptMode): string[] {
  const shared = [
    "Stay inside the ranked likely-cause area; do not refactor unrelated modules.",
    "Do not modify DriftGuard lock code, fixtures, or assertions to force a pass.",
    "Where analysis labels a field 'likely', 'probable', or 'inferred', treat it as a hypothesis — confirm before trusting it.",
  ];
  if (mode === "suggest_patch") {
    return [...shared, "Propose concrete diffs; do not auto-apply.", "Group changes by file with a short rationale per hunk."];
  }
  if (mode === "minimal_fix") {
    return [
      ...shared,
      "Prefer the smallest reversible change in the top-ranked file/module.",
      "If the ranked area does not explain the failure, stop and switch to investigation rather than guessing.",
    ];
  }
  return [
    "DO NOT edit product code yet. DO NOT apply blind fixes.",
    "Do not modify DriftGuard lock code, fixtures, or assertions to force a pass.",
    "Treat the candidate areas below as hypotheses only — confidence is low and ranked files are unavailable.",
    "Produce a diagnosis report, not a patch.",
    "Recommend the smallest next step (targeted experiment, logging, or rollback candidate), not a full change.",
  ];
}

function investigationSteps(): string[] {
  return [
    "Re-run the failing lock with verbose logging (assertion names, output text, fixture hash) and capture the output.",
    "Read the lock's invariants and failed assertions end-to-end; confirm the failure is reproducible and not a flaky detector.",
    "For each candidate module below, review the last 10 commits touching it; note any correlating in time with the first failing run.",
    "Compare the last passing fixture output with the current failing one to isolate which part of the output drifted.",
    "Only after a specific hypothesis is supported by evidence, request a follow-up analysis run (which should promote the tier) before editing code.",
  ];
}

function outputRequirements(mode: PromptMode): string[] {
  if (mode === "suggest_patch") {
    return [
      "Root cause analysis (1–3 paragraphs).",
      "Proposed diffs (exact, per file), with reasoning per hunk.",
      "List of files/modules intentionally NOT changed and why.",
      "Verification steps: which DriftGuard locks will pass after the change and why.",
      "Rollback plan in two lines.",
    ];
  }
  if (mode === "minimal_fix") {
    return [
      "Root cause explanation.",
      "Exact list of files changed.",
      "Summary of the minimal diff applied.",
      "What was intentionally NOT changed.",
      "Why this fix should satisfy each listed rerun lock.",
    ];
  }
  return [
    "Root cause hypothesis (most likely first), tagged HYPOTHESIS — not a conclusion.",
    "Evidence used and evidence deliberately NOT used (e.g. no git diff).",
    "Alternative hypotheses considered, with the reason each is less likely.",
    "Recommended next step (targeted check / experiment / small rollback) — not a patch.",
    "Explicit statement: no product code edits were made.",
  ];
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function shortCommit(hash: string | null | undefined): string {
  if (!hash) return "unknown";
  return String(hash).slice(0, 10);
}

export function buildRepairPlan(
  pack: Pack,
  lock: LockDefinition,
  matches: FailureSignatureMatch[],
  rankedModules: RankedModule[],
  relatedLockKeys: string[],
): RepairPlan {
  const signatureKeys = matches.map((m) => m.key);
  const goalParts =
    signatureKeys.length > 0
      ? signatureKeys.map((k) => pack.signatureGoals[k]).filter(Boolean)
      : [`Restore the invariant(s) declared by ${lock.key}: ${lock.invariants.join(" / ")}`];
  const goal = goalParts.join(" ");

  const scopeConstraints = pack.scopeConstraints[lock.scope] || [];
  const constraints = uniq([...pack.baseConstraints, ...scopeConstraints]);
  const likelyFixAreas = rankedModules.slice(0, 5).map((m) => m.name);

  const regressionRisks = uniq([
    `Altering ${lock.scope} logic can ripple into downstream behaviour — change only within the ranked modules.`,
    "Loosening a guard may over-suppress valid behaviour — rerun all related locks after edits.",
  ]);

  const rerunLocks = uniq([lock.key, ...relatedLockKeys]);
  return { goal, likelyFixAreas, constraints, regressionRisks, rerunLocks };
}

export function buildRepairPrompt(args: {
  pack: Pack;
  lock: LockDefinition;
  failureMessage: string;
  failedAssertions: FailedAssertion[];
  signatures: FailureSignatureMatch[];
  rankedFiles: RankedFile[];
  rankedModules: RankedModule[];
  repairPlan: RepairPlan;
  changedFiles: ChangedFile[];
  analysisStatus: AnalysisStatus;
  confidence: number | null;
  severity: DriftSeverity;
  mode?: PromptMode;
  currentGitCommit?: string | null;
  previousPassingGitCommit?: string | null;
  confidenceExplanation?: string | null;
}): string {
  const {
    pack,
    lock,
    failureMessage,
    failedAssertions,
    signatures,
    rankedFiles,
    rankedModules,
    repairPlan,
    changedFiles,
    analysisStatus,
    confidence,
    severity,
    currentGitCommit,
    previousPassingGitCommit,
    confidenceExplanation,
  } = args;

  const mode: PromptMode = args.mode ?? resolvePromptMode(confidence);
  const tier: ConfidenceTier = resolveConfidenceTier(confidence) ?? "low";

  const driftTypes =
    signatures.length > 0
      ? signatures.map((s) => `\`${s.key}\``).join(", ")
      : "unknown drift pattern (no known signatures matched)";

  const assertionLines = failedAssertions
    .filter((a) => a && (a.name || a.reason))
    .map((a) => `- ${a.name ? `\`${a.name}\`` : "(unnamed)"} — ${a.reason || "no reason provided"}`);

  const scopeImpact =
    pack.scopeImpact[lock.scope] ||
    "Protected behaviour has regressed; user-facing impact unknown until verified.";
  const signatureImpacts = signatures
    .slice(0, 3)
    .map((s) => pack.signatureImpact[s.key])
    .filter(Boolean);
  const impactSummary = [scopeImpact, ...signatureImpacts].join(" ");

  const honesty =
    analysisStatus === "ready"
      ? "Analysis ran with git diff context and signature matching."
      : analysisStatus === "partial"
        ? "Analysis ran with partial context — some inputs were missing; heuristic confidence lowered accordingly."
        : analysisStatus === "error"
          ? "Analysis itself errored; treat all ranking below as unverified."
          : "Analysis ran WITHOUT a git diff — ranked files are unavailable; only candidate modules from lock ownership are listed.";

  const filesVisible = tier === "high" ? rankedFiles : tier === "medium" ? rankedFiles.slice(0, 2) : [];
  const modulesVisibleWithScores = tier !== "low";

  const fileLines = filesVisible.length
    ? filesVisible.map((f) => `- \`${f.path}\` (score ${f.score.toFixed(2)}) — ${f.reason}`)
    : tier === "low"
      ? ["- (withheld — confidence is low; ranked files are not shown to avoid fake precision)"]
      : ["- (none — no git diff context available)"];

  const moduleLines = rankedModules.length
    ? modulesVisibleWithScores
      ? rankedModules.map((m) => `- \`${m.name}\` (score ${m.score.toFixed(2)}) — ${m.reason}`)
      : rankedModules.map((m) => `- \`${m.name}\` — ${m.reason}`)
    : ["- (none declared)"];

  const changedFilesBlock = changedFiles.length
    ? changedFiles.map((f) => `- [${f.changeType}] ${f.path}`).join("\n")
    : "- (no changed-files context available)";

  const sigLines = signatures.length
    ? signatures.map((s) => `- \`${s.key}\` (score ${s.score.toFixed(2)}) — ${s.description}`)
    : ["- (no known signatures matched — may indicate a new drift pattern worth adding to the library)"];

  const requiredOutcomeLines = lock.invariants.length
    ? lock.invariants.map((i) => `- ${i}`)
    : [`- Restore expected behaviour for \`${lock.key}\``];

  const constraintLines = repairPlan.constraints.map((c) => `- ${c}`);
  const behaviourLines = behaviouralRequirements(mode).map((b) => `- ${b}`);
  const rerunLines = repairPlan.rerunLocks.map((k) => `- \`${k}\``);
  const outputLines = outputRequirements(mode).map((o, i) => `${i + 1}. ${o}`);

  const header = [
    `# DriftGuard repair prompt — ${lock.key}`,
    "",
    `Lock: **${lock.name}** (scope: \`${lock.scope}\`)`,
    `Mode: \`${mode}\` — ${modeHeadline(mode)}`,
    `Severity: \`${severity}\``,
    `Confidence: \`${tier}\`${typeof confidence === "number" ? ` (${(confidence * 100).toFixed(0)}%)` : " (unknown)"}`,
    `Analysis status: \`${analysisStatus}\` — ${honesty}`,
    ...(currentGitCommit || previousPassingGitCommit
      ? [
          `Commit range: ${previousPassingGitCommit ? `\`${shortCommit(previousPassingGitCommit)}\`` : "`(last passing unknown)`"} → ${currentGitCommit ? `\`${shortCommit(currentGitCommit)}\`` : "`(current unknown)`"}`,
        ]
      : []),
    ...(confidenceExplanation ? [`Confidence explanation: ${confidenceExplanation}`] : []),
    "",
  ];

  const investigationBanner =
    tier === "low"
      ? [
          "> **INVESTIGATION MODE — DO NOT APPLY BLIND FIXES.**",
          "> Confidence is below 40%. Ranked files are intentionally withheld to avoid fake",
          "> precision. Your job is to diagnose, not to patch.",
          "",
        ]
      : [];

  const investigationStepsBlock =
    tier === "low"
      ? ["## Investigation steps", "", ...investigationSteps().map((s, i) => `${i + 1}. ${s}`), ""]
      : [];

  return [
    ...header,
    ...investigationBanner,
    "## 1. Drift summary",
    "",
    `- Feature lock failed: **${lock.name}**`,
    `- Feature key: \`${lock.key}\``,
    `- Scope: \`${lock.scope}\``,
    `- Drift types: ${driftTypes}`,
    `- Severity: ${severity}`,
    `- Confidence tier: **${tier}**`,
    "",
    "## 2. What failed",
    "",
    `Failure message: ${failureMessage || "(no message)"}`,
    "",
    "Failed assertions:",
    assertionLines.length ? assertionLines.join("\n") : "- (none reported by lock)",
    "",
    "## 3. Business / system impact",
    "",
    impactSummary,
    "",
    "## 4. Likely cause",
    "",
    repairPlan.goal,
    "",
    tier === "low" ? "## 5. Candidate system areas (modules only)" : "## 5. Most likely changed files / areas",
    "",
    ...(tier === "low" ? [] : [fileLines.join("\n"), ""]),
    tier === "low" ? "Candidate modules:" : "Modules (ranked):",
    moduleLines.join("\n"),
    "",
    "Changed files since last passing run:",
    changedFilesBlock,
    "",
    "## 6. Known failure signatures",
    "",
    sigLines.join("\n"),
    "",
    "## 7. Required fix outcome",
    "",
    "After the patch, these invariants must hold:",
    requiredOutcomeLines.join("\n"),
    "",
    ...investigationStepsBlock,
    "## 8. Constraints (do NOT violate)",
    "",
    constraintLines.join("\n"),
    "",
    "## 9. Behavioural requirements",
    "",
    behaviourLines.join("\n"),
    "",
    "## 10. Verification — rerun locks",
    "",
    "Run these DriftGuard locks; each must return status `pass`:",
    "",
    rerunLines.join("\n"),
    "",
    "## 11. Output requirements",
    "",
    outputLines.join("\n"),
    "",
    "---",
    "",
    "DriftGuard does not apply this prompt automatically. Any code change is the responsibility of",
    "the engineer or agent acting on it. Lock logic, fixtures, and assertions must not be edited to",
    "force a pass.",
    "",
  ].join("\n");
}
