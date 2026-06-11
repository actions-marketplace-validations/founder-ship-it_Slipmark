/**
 * Analysis orchestration — builds a DriftAnalysisReport for a failed lock.
 * Never throws; returns an error-status report instead.
 */
import type {
  AnalysisStatus,
  BisectOutcome,
  DriftAnalysisReport,
  ExecutionTrace,
  FailedAssertion,
  FailureSignatureMatch,
  GitContext,
  LockDefinition,
  Pack,
  PromptMode,
  RankedFile,
  RankedModule,
} from "../types.js";
import { matchFailureSignatures } from "./signatures.js";
import { describeDiffAvailability, matchDiffKeywords, normaliseGitContext } from "./gitDiff.js";
import { rankChangedFilesForLock, rankModulesForLock } from "./scorer.js";
import { changedWatchedSymbols as intersectWatchedSymbols, extractChangedSymbols } from "./symbols.js";
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
  failedItem: {
    status: "drift" | "error" | "skipped" | "pass";
    message: string;
    failedAssertions: FailedAssertion[];
    trace?: ExecutionTrace;
  };
  gitContext?: GitContext | null;
  /** Optional bisection outcome, pre-computed by the host (it owns the working tree). */
  bisect?: BisectOutcome | null;
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
    let rankedModules = rankModulesForLock(lock, matches, changedFiles, pack.signatureToModules);

    // ----- Execution trace (lock-supplied OR git-context-supplied) ----------------------------
    const executionTrace: ExecutionTrace | null =
      failedItem.trace ?? (git.executionTrace as ExecutionTrace | null) ?? null;
    const hasExecutionTrace = Boolean(
      executionTrace && typeof executionTrace === "object" && Object.keys(executionTrace).length > 0,
    );
    // The trace corroborates if its modules overlap the lock's owned/ranked modules,
    // or it carries observations of the failing mechanism.
    const declaredModuleSet = new Set([...(lock.likelyModules || []), ...rankedModules.map((m) => m.name)]);
    const traceModules = executionTrace?.modules || [];
    const traceCorroborates =
      traceModules.some((m) => declaredModuleSet.has(m)) ||
      Boolean(executionTrace?.observations && Object.keys(executionTrace.observations).length > 0);
    // Boost ranked modules that the trace actually exercised.
    if (hasExecutionTrace && traceModules.length > 0) {
      rankedModules = boostModulesByTrace(rankedModules, traceModules);
    }

    // ----- Changed watched-symbols (earned causal evidence) -----------------------------------
    const changedSymbols = new Set<string>();
    for (const f of changedFiles) {
      for (const s of extractChangedSymbols(`${f.diffExcerpt || ""}`)) changedSymbols.add(s);
    }
    const changedWatched = intersectWatchedSymbols(lock.watchedSymbols, Array.from(changedSymbols));

    // ----- Bisection (host-supplied) ----------------------------------------------------------
    const bisect = args.bisect ?? null;
    const hasBisectCulprit = Boolean(bisect && bisect.firstFailingCommit);

    const hasGitDiff = availability.available;
    const lockDeclaredSignature = matches.some((m) => m.evidence.some((e) => e.startsWith("lock_declared:")));
    const ownedChangedFilesCount = rawRankedFiles.length;

    const diffKeywordHits = new Set<string>();
    for (const f of changedFiles) {
      for (const k of matchDiffKeywords(`${f.path} ${f.diffExcerpt || ""} ${git.diffSummary || ""}`, pack.diffKeywords)) {
        diffKeywordHits.add(k);
      }
    }
    const diffKeywordHitCount = diffKeywordHits.size;

    const analysisStatus: AnalysisStatus =
      hasGitDiff || hasBisectCulprit ? "ready" : hasExecutionTrace || matches.length > 0 ? "partial" : "unavailable";

    const repairPlan = buildRepairPlan(pack, lock, matches, rankedModules, relatedLockKeys(lock, registry));

    const confidenceResult = computeStructuredConfidence({
      matches,
      rankedFiles: rawRankedFiles,
      hasGitDiff,
      hasExecutionTrace,
      traceCorroborates,
      hasBisectCulprit,
      changedWatchedSymbolCount: changedWatched.length,
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
      hasBisectCulprit,
      changedFilesCount: changedFiles.length,
      ownedChangedFilesCount,
      topSignatureKey: matches[0]?.key ?? null,
      diffKeywordHitCount,
      changedWatchedSymbolCount: changedWatched.length,
    });

    const rankedFiles = applyTierVisibility(rawRankedFiles, confidenceTier);
    const promptMode: PromptMode = resolvePromptMode(confidence);
    const severity = resolveSeverity(lock, matches, false);
    const likelyCauseSummary = summariseLikelyCause(matches, rankedFiles, analysisStatus);

    // Bisection gives the most precise commit range; fall back to the git context.
    const currentGitCommit = bisect?.firstFailingCommit ?? git.currentCommit ?? null;
    const previousPassingGitCommit = bisect?.lastPassingCommit ?? git.lastPassingCommit ?? null;

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
      currentGitCommit,
      previousPassingGitCommit,
      confidenceExplanation,
      executionTrace,
      changedWatchedSymbols: changedWatched,
      bisect,
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
    notes.push(
      hasExecutionTrace
        ? `Execution trace present${traceCorroborates ? " and corroborates the failing mechanism" : " (uncorroborated)"}.`
        : "No execution trace recorded by the lock.",
    );
    if (changedWatched.length > 0) {
      notes.push(`Watched symbols changed in diff: ${changedWatched.map((s) => `\`${s}\``).join(", ")}.`);
    }
    if (hasBisectCulprit) {
      notes.push(`Bisection: culprit \`${bisect!.firstFailingCommit}\` (last good \`${bisect!.lastPassingCommit ?? "unknown"}\`, ${bisect!.evaluated} probes).`);
    }
    if (confidenceBreakdown) {
      notes.push(
        `Confidence breakdown — sig:${confidenceBreakdown.signatureMatch.toFixed(2)}, ownership:${confidenceBreakdown.lockOwnershipMatch.toFixed(2)}, diff:${confidenceBreakdown.gitDiffMatch.toFixed(2)}, keywords:${confidenceBreakdown.diffKeywordAlignment.toFixed(2)}, trace:${confidenceBreakdown.executionTraceMatch.toFixed(2)}, bisect:${confidenceBreakdown.bisectMatch.toFixed(2)}, symbol:${confidenceBreakdown.symbolMatch.toFixed(2)}${confidenceBreakdown.capsApplied.length ? ` | caps: ${confidenceBreakdown.capsApplied.join(",")}` : ""}.`,
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
      currentGitCommit,
      previousPassingGitCommit,
      executionTrace,
      changedWatchedSymbols: changedWatched,
      bisect,
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
      executionTrace: null,
      changedWatchedSymbols: [],
      bisect: null,
      notes: ["analysis_error"],
    };
  }
}

/** Boost ranked modules the execution trace actually exercised (observed evidence). */
function boostModulesByTrace(modules: RankedModule[], traceModules: string[]): RankedModule[] {
  const traced = new Set(traceModules);
  const boosted = modules.map((m) =>
    traced.has(m.name)
      ? { ...m, score: Math.min(m.score + 0.2, 0.97), reason: `${m.reason}; exercised by execution trace` }
      : m,
  );
  // Surface any traced module not already ranked.
  for (const name of traceModules) {
    if (!boosted.some((m) => m.name === name)) {
      boosted.push({ name, score: 0.5, reason: "exercised by execution trace" });
    }
  }
  boosted.sort((a, b) => b.score - a.score);
  return boosted.slice(0, 8);
}
