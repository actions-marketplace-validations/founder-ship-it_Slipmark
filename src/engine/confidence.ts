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
  lockDeclaredSignature: boolean;
  diffKeywordHitCount: number;
}): { confidence: number; breakdown: ConfidenceBreakdown } | null {
  const {
    matches,
    rankedFiles,
    hasGitDiff,
    hasExecutionTrace,
    lockDeclaredSignature,
    diffKeywordHitCount,
  } = params;

  const hasAnySignal = matches.length > 0 || hasGitDiff || hasExecutionTrace;
  if (!hasAnySignal) return null;

  const topSig = matches[0]?.score ?? 0;
  const topFile = rankedFiles[0]?.score ?? 0;
  const capsApplied: string[] = [];

  const signatureMatch = Math.min(Math.max(topSig, 0), 1) * 0.3;
  const lockOwnershipMatch = lockDeclaredSignature ? 0.15 : 0;
  const gitDiffMatch = hasGitDiff && rankedFiles.length > 0 ? Math.min(topFile, 1) * 0.25 : 0;
  const diffKeywordAlignment =
    hasGitDiff && diffKeywordHitCount > 0 ? Math.min(0.2, diffKeywordHitCount * 0.05) : 0;
  // Reserved: runner does not yet capture runtime traces. Stays 0 until wired.
  const executionTraceMatch = hasExecutionTrace ? 0.3 : 0;

  let total =
    signatureMatch + lockOwnershipMatch + gitDiffMatch + diffKeywordAlignment + executionTraceMatch;

  if (!hasGitDiff && !hasExecutionTrace) {
    const cap = 0.4;
    if (total > cap) capsApplied.push("no_diff_no_trace_cap_0.40");
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
      capsApplied,
    },
  };
}

export function explainConfidence(params: {
  tier: ConfidenceTier | null;
  breakdown: ConfidenceBreakdown | null;
  hasGitDiff: boolean;
  hasExecutionTrace: boolean;
  changedFilesCount: number;
  ownedChangedFilesCount: number;
  topSignatureKey: string | null;
  diffKeywordHitCount: number;
}): string | null {
  const {
    tier,
    breakdown,
    hasGitDiff,
    hasExecutionTrace,
    changedFilesCount,
    ownedChangedFilesCount,
    topSignatureKey,
    diffKeywordHitCount,
  } = params;
  if (!tier || !breakdown) return null;

  if (!hasGitDiff && !hasExecutionTrace) {
    return [
      "Confidence is capped at 40% because DriftGuard had no git diff and no execution trace for this run.",
      topSignatureKey
        ? `A failure signature (\`${topSignatureKey}\`) matched the assertion pattern, but signature heuristics alone are not treated as proof.`
        : "No known failure signature matched — treat the candidate modules as hypotheses only.",
    ].join(" ");
  }

  const tierHead =
    tier === "high" ? "Confidence is high" : tier === "medium" ? "Confidence is medium" : "Confidence is low";
  const reasons: string[] = [];

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
  if (breakdown.signatureMatch > 0.12 && topSignatureKey) {
    reasons.push(`the failure signature \`${topSignatureKey}\` matched strongly`);
  }
  if (diffKeywordHitCount > 0 && hasGitDiff) {
    reasons.push(
      `diff keywords align with the lock's behavioural intent (${diffKeywordHitCount} match${diffKeywordHitCount === 1 ? "" : "es"})`,
    );
  }
  if (!hasExecutionTrace) reasons.push("no execution trace was available");

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
