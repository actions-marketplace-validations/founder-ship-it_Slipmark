/**
 * Analysis orchestration — builds a DriftAnalysisReport for a failed lock.
 * Never throws; returns an error-status report instead.
 */
import type {
  AnalysisStatus,
  DriftAnalysisReport,
  FailedAssertion,
  FailureSignatureMatch,
  GitContext,
  LockDefinition,
  Pack,
  PromptMode,
  RankedFile,
} from "../types.js";
import { matchFailureSignatures } from "./signatures.js";
import { describeDiffAvailability, matchDiffKeywords, normaliseGitContext } from "./gitDiff.js";
import { rankChangedFilesForLock, rankModulesForLock } from "./scorer.js";
import {
  applyTierVisibility,
  computeStructuredConfidence,
  explainConfidence,
  resolveConfidenceTier,
} from "./confidence.js";
import { buildRepairPlan, buildRepairPrompt, resolvePromptMode, resolveSeverity } from "./repairPlan.js";

function relatedLockKeys(lock: LockDefinition, registry: LockDefinition[]): string[] {
  const lockDomains = new Set((lock.domains || []).map((d) => d.toLowerCase()));
  return registry
    .filter((l) => l.key !== lock.key)
    .filter((l) => l.scope === lock.scope || (l.domains || []).some((d) => lockDomains.has(d.toLowerCase())))
    .map((l) => l.key);
}

function summariseLikelyCause(
  matches: FailureSignatureMatch[],
  rankedFiles: RankedFile[],
  analysisStatus: AnalysisStatus,
): string {
  if (matches.length === 0 && rankedFiles.length === 0) {
    return analysisStatus === "ready"
      ? "No known drift signature matched and no relevant files changed — likely a new failure mode; manual review recommended."
      : "Inferred: analysis ran without git diff context; manual review of the lock's declared owner files is recommended.";
  }
  const topSig = matches[0];
  const topFile = rankedFiles[0];
  const parts: string[] = [];
  if (topSig) parts.push(`Likely: ${topSig.label.toLowerCase()} — ${topSig.description.toLowerCase()}`);
  if (topFile) {
    parts.push(
      analysisStatus === "ready"
        ? `Probable hot-spot: \`${topFile.path}\` (${(topFile.score * 100).toFixed(0)}% relevance).`
        : `Inferred hot-spot (no git diff): \`${topFile.path}\` — declared owner of this lock.`,
    );
  }
  if (matches.length > 1) {
    parts.push(`Other signatures present: ${matches.slice(1).map((m) => m.label.toLowerCase()).join(", ")}.`);
  }
  return parts.join(" ");
}

export function buildDriftAnalysisReport(args: {
  pack: Pack;
  lock: LockDefinition;
  registry: LockDefinition[];
  failedItem: { status: "drift" | "error" | "skipped" | "pass"; message: string; failedAssertions: FailedAssertion[] };
  gitContext?: GitContext | null;
}): DriftAnalysisReport {
  const { pack, lock, registry, failedItem } = args;

  try {
    const git = normaliseGitContext(args.gitContext);
    const availability = describeDiffAvailability(git);
    const changedFiles = git.changedFiles || [];
    const failedAssertions = Array.isArray(failedItem.failedAssertions) ? failedItem.failedAssertions : [];

    const matches = matchFailureSignatures(
      pack.signatures,
      failedAssertions,
      failedItem.message || "",
      lock.failureSignatures,
    );

    const rankResult = rankChangedFilesForLock(lock, changedFiles, matches, pack.diffKeywords, git.diffSummary || null);
    const rawRankedFiles = rankResult.ranked;
    const rankedModules = rankModulesForLock(lock, matches, changedFiles, pack.signatureToModules);

    const hasGitDiff = availability.available;
    const hasExecutionTrace = Boolean(
      git.executionTrace && typeof git.executionTrace === "object" && Object.keys(git.executionTrace).length > 0,
    );
    const lockDeclaredSignature = matches.some((m) => m.evidence.some((e) => e.startsWith("lock_declared:")));
    const ownedChangedFilesCount = rawRankedFiles.length;

    const diffKeywordHits = new Set<string>();
    for (const f of changedFiles) {
      for (const k of matchDiffKeywords(`${f.path} ${f.diffExcerpt || ""} ${git.diffSummary || ""}`, pack.diffKeywords)) {
        diffKeywordHits.add(k);
      }
    }
    const diffKeywordHitCount = diffKeywordHits.size;

    const analysisStatus: AnalysisStatus = hasGitDiff ? "ready" : matches.length > 0 ? "partial" : "unavailable";

    const repairPlan = buildRepairPlan(pack, lock, matches, rankedModules, relatedLockKeys(lock, registry));

    const confidenceResult = computeStructuredConfidence({
      matches,
      rankedFiles: rawRankedFiles,
      hasGitDiff,
      hasExecutionTrace,
      lockDeclaredSignature,
      diffKeywordHitCount,
    });
    const confidence = confidenceResult?.confidence ?? null;
    const confidenceBreakdown = confidenceResult?.breakdown ?? null;
    const confidenceTier = resolveConfidenceTier(confidence);

    const confidenceExplanation = explainConfidence({
      tier: confidenceTier,
      breakdown: confidenceBreakdown,
      hasGitDiff,
      hasExecutionTrace,
      changedFilesCount: changedFiles.length,
      ownedChangedFilesCount,
      topSignatureKey: matches[0]?.key ?? null,
      diffKeywordHitCount,
    });

    const rankedFiles = applyTierVisibility(rawRankedFiles, confidenceTier);
    const promptMode: PromptMode = resolvePromptMode(confidence);
    const severity = resolveSeverity(lock, matches, false);
    const likelyCauseSummary = summariseLikelyCause(matches, rankedFiles, analysisStatus);

    const repairPrompt = buildRepairPrompt({
      pack,
      lock,
      failureMessage: failedItem.message || "",
      failedAssertions,
      signatures: matches,
      rankedFiles: rawRankedFiles,
      rankedModules,
      repairPlan,
      changedFiles,
      analysisStatus,
      confidence,
      severity,
      mode: promptMode,
      currentGitCommit: git.currentCommit,
      previousPassingGitCommit: git.lastPassingCommit,
      confidenceExplanation,
    });

    const notes: string[] = [];
    if (rankResult.source === "inferred") {
      notes.push("No git diff context was provided; ranked files are omitted to avoid fake precision. Candidate modules surfaced instead.");
    }
    notes.push(
      availability.available
        ? `Diff availability: available (${availability.changedFilesCount} changed files${availability.hasDiffSummary ? ", with diff summary" : ""}).`
        : `Diff availability: unavailable (${availability.reason}).`,
    );
    if (matches.length === 0) notes.push("No known failure signature matched — possible new drift pattern.");
    if (!hasExecutionTrace) notes.push("No execution trace evidence available (reserved signal).");
    if (confidenceBreakdown) {
      notes.push(
        `Confidence breakdown — sig:${confidenceBreakdown.signatureMatch.toFixed(2)}, ownership:${confidenceBreakdown.lockOwnershipMatch.toFixed(2)}, diff:${confidenceBreakdown.gitDiffMatch.toFixed(2)}, keywords:${confidenceBreakdown.diffKeywordAlignment.toFixed(2)}, trace:${confidenceBreakdown.executionTraceMatch.toFixed(2)}${confidenceBreakdown.capsApplied.length ? ` | caps: ${confidenceBreakdown.capsApplied.join(",")}` : ""}.`,
      );
    }

    return {
      analysisStatus,
      likelyCauseSummary,
      likelyFailureSignatures: matches.map((m) => m.key),
      changedFiles,
      rankedFiles,
      rankedModules,
      repairPlan,
      repairPrompt,
      promptMode,
      severity,
      confidence,
      confidenceTier,
      confidenceBreakdown,
      confidenceExplanation,
      currentGitCommit: git.currentCommit ?? null,
      previousPassingGitCommit: git.lastPassingCommit ?? null,
      notes,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      analysisStatus: "error",
      likelyCauseSummary: `Analysis failed: ${message}`,
      likelyFailureSignatures: [],
      changedFiles: [],
      rankedFiles: [],
      rankedModules: [],
      repairPlan: { goal: "Analysis was not generated; investigate drift manually.", likelyFixAreas: [], constraints: [], regressionRisks: [], rerunLocks: [lock.key] },
      repairPrompt: null,
      promptMode: "investigate_first",
      severity: resolveSeverity(lock, [], true),
      confidence: null,
      confidenceTier: null,
      confidenceBreakdown: null,
      confidenceExplanation: null,
      currentGitCommit: null,
      previousPassingGitCommit: null,
      notes: ["analysis_error"],
    };
  }
}
