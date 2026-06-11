/**
 * Structured confidence scoring + the honesty guarantees that make DriftGuard
 * different: it refuses to present pattern heuristics as proof.
 *
 *   - Confidence is hard-capped at 0.40 when there is no git diff and no
 *     execution trace. Signature matches alone are heuristics, not causality.
 *   - Low confidence withholds ranked files entirely (see applyTierVisibility)
 *     to avoid fake precision.
 *
 * These are deliberate. Most tools over-claim here; this one under-claims.
 */
import type {
  ConfidenceBreakdown,
  ConfidenceTier,
  FailureSignatureMatch,
  RankedFile,
} from "../types.js";

export function resolveConfidenceTier(confidence: number | null): ConfidenceTier | null {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return null;
  if (confidence >= 0.7) return "high";
  if (confidence >= 0.4) return "medium";
  return "low";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeStructuredConfidence(params: {
  matches: FailureSignatureMatch[];
  rankedFiles: RankedFile[];
  hasGitDiff: boolean;
  hasExecutionTrace: boolean;
  /** Does the trace corroborate the lock (overlapping modules / observations)? */
  traceCorroborates: boolean;
  /** Did bisection confirm a culprit commit? Strongest causal evidence. */
  hasBisectCulprit: boolean;
  /** How many of the lock's watched symbols actually changed in the diff. */
  changedWatchedSymbolCount: number;
  lockDeclaredSignature: boolean;
  diffKeywordHitCount: number;
}): { confidence: number; breakdown: ConfidenceBreakdown } | null {
  const {
    matches,
    rankedFiles,
    hasGitDiff,
    hasExecutionTrace,
    traceCorroborates,
    hasBisectCulprit,
    changedWatchedSymbolCount,
    lockDeclaredSignature,
    diffKeywordHitCount,
  } = params;

  const hasAnySignal = matches.length > 0 || hasGitDiff || hasExecutionTrace || hasBisectCulprit;
  if (!hasAnySignal) return null;

  const topSig = matches[0]?.score ?? 0;
  const topFile = rankedFiles[0]?.score ?? 0;
  const capsApplied: string[] = [];

  const signatureMatch = Math.min(Math.max(topSig, 0), 1) * 0.3;
  const lockOwnershipMatch = lockDeclaredSignature ? 0.15 : 0;
  const gitDiffMatch = hasGitDiff && rankedFiles.length > 0 ? Math.min(topFile, 1) * 0.25 : 0;
  const diffKeywordAlignment =
    hasGitDiff && diffKeywordHitCount > 0 ? Math.min(0.2, diffKeywordHitCount * 0.05) : 0;
  // Execution trace: now a real signal. Base for having a trace, bonus when it
  // corroborates the lock (observed mechanism, not just "a trace exists").
  const executionTraceMatch = hasExecutionTrace ? (traceCorroborates ? 0.25 : 0.15) : 0;
  // Bisection: a confirmed culprit commit is the strongest causal evidence.
  const bisectMatch = hasBisectCulprit ? 0.3 : 0;
  // Changed watched-symbol: the specific code behind the invariant changed.
  const symbolMatch = hasGitDiff && changedWatchedSymbolCount > 0 ? Math.min(0.2, changedWatchedSymbolCount * 0.12) : 0;

  let total =
    signatureMatch +
    lockOwnershipMatch +
    gitDiffMatch +
    diffKeywordAlignment +
    executionTraceMatch +
    bisectMatch +
    symbolMatch;

  // Three-tier honesty cap, by strength of causal evidence:
  //   no diff, no trace, no bisect → 0.40  (pattern heuristic only)
  //   trace but no diff/bisect     → 0.69  (we know the mechanism, not the commit)
  //   git diff OR bisect culprit   → uncapped (can reach high)
  const hasCausalEvidence = hasGitDiff || hasBisectCulprit;
  if (!hasCausalEvidence && !hasExecutionTrace) {
    const cap = 0.4;
    if (total > cap) capsApplied.push("no_evidence_cap_0.40");
    total = Math.min(total, cap);
  } else if (!hasCausalEvidence) {
    const cap = 0.69;
    if (total > cap) capsApplied.push("trace_only_cap_0.69");
    total = Math.min(total, cap);
  }

  total = Math.round(Math.min(Math.max(total, 0), 0.99) * 100) / 100;

  return {
    confidence: total,
    breakdown: {
      signatureMatch: round2(signatureMatch),
      lockOwnershipMatch: round2(lockOwnershipMatch),
      gitDiffMatch: round2(gitDiffMatch),
      diffKeywordAlignment: round2(diffKeywordAlignment),
      executionTraceMatch: round2(executionTraceMatch),
      bisectMatch: round2(bisectMatch),
      symbolMatch: round2(symbolMatch),
      capsApplied,
    },
  };
}

export function explainConfidence(params: {
  tier: ConfidenceTier | null;
  breakdown: ConfidenceBreakdown | null;
  hasGitDiff: boolean;
  hasExecutionTrace: boolean;
  hasBisectCulprit: boolean;
  changedFilesCount: number;
  ownedChangedFilesCount: number;
  topSignatureKey: string | null;
  diffKeywordHitCount: number;
  changedWatchedSymbolCount: number;
}): string | null {
  const {
    tier,
    breakdown,
    hasGitDiff,
    hasExecutionTrace,
    hasBisectCulprit,
    changedFilesCount,
    ownedChangedFilesCount,
    topSignatureKey,
    diffKeywordHitCount,
    changedWatchedSymbolCount,
  } = params;
  if (!tier || !breakdown) return null;

  const hasCausalEvidence = hasGitDiff || hasBisectCulprit;

  if (!hasCausalEvidence && !hasExecutionTrace) {
    return [
      "Confidence is capped at 40% because DriftGuard had no git diff, no execution trace, and no bisected commit for this run.",
      topSignatureKey
        ? `A failure signature (\`${topSignatureKey}\`) matched the assertion pattern, but signature heuristics alone are not treated as proof.`
        : "No known failure signature matched — treat the candidate modules as hypotheses only.",
    ].join(" ");
  }

  if (!hasCausalEvidence) {
    return [
      "Confidence is capped at 69% (medium) because DriftGuard has an execution trace of the failing mechanism but no git diff or bisected commit linking it to a specific change.",
      "The trace tells us what went wrong; it does not yet tell us which change caused it.",
    ].join(" ");
  }

  const tierHead =
    tier === "high" ? "Confidence is high" : tier === "medium" ? "Confidence is medium" : "Confidence is low";
  const reasons: string[] = [];

  if (hasBisectCulprit) reasons.push("bisection identified a specific culprit commit");
  if (hasGitDiff) {
    if (ownedChangedFilesCount > 0) {
      reasons.push(
        `${ownedChangedFilesCount} changed file${ownedChangedFilesCount === 1 ? "" : "s"} overlap the lock's owned modules`,
      );
    } else if (changedFilesCount > 0) {
      reasons.push(
        `${changedFilesCount} file${changedFilesCount === 1 ? "" : "s"} changed since the last passing run, but none match the lock's owned modules`,
      );
    }
  }
  if (changedWatchedSymbolCount > 0) {
    reasons.push(
      `${changedWatchedSymbolCount} watched symbol${changedWatchedSymbolCount === 1 ? "" : "s"} the lock depends on changed in the diff`,
    );
  }
  if (hasExecutionTrace) reasons.push("an execution trace corroborates the failing mechanism");
  if (breakdown.signatureMatch > 0.12 && topSignatureKey) {
    reasons.push(`the failure signature \`${topSignatureKey}\` matched strongly`);
  }
  if (diffKeywordHitCount > 0 && hasGitDiff) {
    reasons.push(
      `diff keywords align with the lock's behavioural intent (${diffKeywordHitCount} match${diffKeywordHitCount === 1 ? "" : "es"})`,
    );
  }

  const body = reasons.length > 0 ? ` because ${reasons.join(", and ")}` : "";
  return `${tierHead}${body}.`;
}

/**
 * Tier-based visibility:
 *   high   → all ranked files
 *   medium → top 2 ranked files
 *   low    → NO ranked files (prevents fake precision)
 */
export function applyTierVisibility(rankedFiles: RankedFile[], tier: ConfidenceTier | null): RankedFile[] {
  if (tier === "high") return rankedFiles;
  if (tier === "medium") return rankedFiles.slice(0, 2);
  return [];
}
