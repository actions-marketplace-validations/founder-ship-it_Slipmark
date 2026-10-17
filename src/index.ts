/**
 * DriftGuard — public API.
 *
 * The engine is domain-agnostic. Supply a `Pack` (signatures, system map,
 * constraints, locks) and it will run the locks, detect drift, score confidence
 * honestly, and emit a coding-agent-ready repair prompt.
 */
export * from "./types.js";
export { runPack } from "./engine/runner.js";
export type { LockRunOutcome, VerificationRun } from "./engine/runner.js";
export { buildDriftAnalysisReport } from "./engine/analyze.js";
export { matchFailureSignatures, listSignatures } from "./engine/signatures.js";
export {
  computeStructuredConfidence,
  resolveConfidenceTier,
  explainConfidence,
  applyTierVisibility,
} from "./engine/confidence.js";
export { buildRepairPlan, buildRepairPrompt, resolvePromptMode, resolveSeverity } from "./engine/repairPlan.js";
export { rankChangedFilesForLock, rankModulesForLock } from "./engine/scorer.js";
export { normaliseGitContext, describeDiffAvailability, matchDiffKeywords } from "./engine/gitDiff.js";
export { bisectFirstFailing } from "./engine/bisect.js";
export type { CommitProbe, BisectResult, BisectRunner } from "./engine/bisect.js";
export { extractChangedSymbols, changedWatchedSymbols } from "./engine/symbols.js";
export { runGitBisect, listCommits, currentRef, createShellProbe } from "./integrations/gitBisect.js";
export type { GitBisectOptions } from "./integrations/gitBisect.js";
export { compileDeclarativePack, evaluateAssertions } from "./authoring/declarative.js";
export type {
  DeclarativePack,
  DeclarativeLock,
  DeclarativeAssertion,
  DeclarativeSignature,
  DeclarativeTarget,
  AssertionType,
  RunTarget,
} from "./authoring/declarative.js";
export { loadDeclarativePack } from "./integrations/declarativeLoader.js";
export { summariseRun, appendRun } from "./dashboard/data.js";
export type { DashboardData, RunSummary, LockSummary } from "./dashboard/data.js";
export { renderDashboardHtml } from "./dashboard/render.js";
export {
  ATTESTATION_SCHEMA,
  PASSING_VERDICTS,
  createAttestation,
  writeAttestation,
  defaultAttestationPath,
  verifyAttestations,
  sha256File,
} from "./attest/attestation.js";
export type { Attestation, AttestedSubject, Verdict, CheckResult, CheckStatus, VerifyReport } from "./attest/attestation.js";

export {
  repairArtifactsFor,
  repairIndexDoc,
  claudeCodeCommandFor,
  agentRulesDoc,
} from "./integrations/codingAgent.js";
export type { RepairArtifact } from "./integrations/codingAgent.js";

/** Convenience helper for defining a pack with type-checking. */
import type { Pack } from "./types.js";
export function definePack(pack: Pack): Pack {
  return pack;
}
