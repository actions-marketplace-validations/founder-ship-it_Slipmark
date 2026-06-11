/**
 * Failure-signature matching machinery (domain-agnostic).
 *
 * The machinery lives in the engine; the actual signatures live in the Pack.
 * Heuristic only — advisory, never used to auto-modify code.
 */
import type { FailedAssertion, FailureSignatureMatch, SignatureDefinition } from "../types.js";

/**
 * Match a failed verification item against a pack's signature library.
 * Returns signatures sorted by score (desc). Score is 0..1, heuristic only.
 */
export function matchFailureSignatures(
  signatures: SignatureDefinition[],
  failedAssertions: FailedAssertion[],
  message: string,
  lockDeclaredSignatures: string[] | undefined,
): FailureSignatureMatch[] {
  const corpus = [
    String(message || ""),
    ...failedAssertions.map((a) => `${a?.name ?? ""} ${a?.reason ?? ""}`),
  ]
    .join(" \n ")
    .toLowerCase();

  const assertionNames = new Set(
    failedAssertions.map((a) => String(a?.name || "").toLowerCase().trim()).filter(Boolean),
  );
  const lockSignatureSet = new Set(
    (lockDeclaredSignatures || []).map((s) => String(s).toLowerCase().trim()),
  );

  const matches: FailureSignatureMatch[] = [];

  for (const sig of signatures) {
    const evidence: string[] = [];
    let score = 0;

    for (const an of sig.assertionNames) {
      if (assertionNames.has(an.toLowerCase())) {
        evidence.push(`assertion:${an}`);
        score += 0.45;
      }
    }
    for (const pat of sig.patterns) {
      if (pat.test(corpus)) {
        evidence.push(`pattern:${pat.source}`);
        score += 0.18;
      }
    }
    if (lockSignatureSet.has(sig.key.toLowerCase())) {
      evidence.push(`lock_declared:${sig.key}`);
      score += 0.22;
    }

    if (evidence.length === 0) continue;

    matches.push({
      key: sig.key,
      label: sig.label,
      description: sig.description,
      score: Math.min(score, 0.99),
      evidence,
    });
  }

  matches.sort((a, b) => b.score - a.score);
  return matches;
}

export function listSignatures(
  signatures: SignatureDefinition[],
): { key: string; label: string; description: string }[] {
  return signatures.map(({ key, label, description }) => ({ key, label, description }));
}
