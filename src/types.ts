/**
 * DriftGuard — core domain-agnostic types.
 *
 * The engine knows NOTHING about any specific product. All domain knowledge
 * (signatures, module maps, constraints, fixtures) is supplied by a `Pack`.
 * ReplyOS is one pack; the demo-shop pack is another. That is the whole point
 * of the standalone extraction: same engine, swappable domain.
 */

export type LockScope = string; // e.g. "ai" | "messaging" | "billing" | "tenancy" | custom

export type ConfidenceTier = "high" | "medium" | "low";
export type PromptMode = "suggest_patch" | "minimal_fix" | "investigate_first";
export type DriftSeverity = "critical" | "high" | "medium" | "low";
export type AnalysisStatus = "ready" | "partial" | "unavailable" | "error";
export type ContextDepthMode = "fast" | "standard" | "deep";

/** Result of running a single lock's verification against its fixtures. */
export interface LockResult {
  status: "pass" | "drift" | "error" | "skipped";
  message: string;
  failedAssertions: FailedAssertion[];
}

export interface FailedAssertion {
  name?: string;
  reason?: string;
}

/**
 * A lock is a codified behavioral invariant. `run()` is deterministic: given the
 * same fixtures, a correct implementation always returns the same result.
 */
export interface LockDefinition {
  key: string;
  name: string;
  scope: LockScope;
  domains?: string[];
  invariants: string[];
  /** Glob patterns the lock declares as its likely owning files. */
  likelyFiles?: string[];
  /** Module keys the lock declares as its likely owning modules. */
  likelyModules?: string[];
  /** Signature keys the lock pre-declares as plausible failure modes. */
  failureSignatures?: string[];
  /** Deterministic verification. Should never throw; return status "error" instead. */
  run(): LockResult;
}

/** A failure pattern: how to recognise a known class of drift from a failed lock. */
export interface SignatureDefinition {
  key: string;
  label: string;
  description: string;
  /** Exact assertion-name matches (strong evidence). */
  assertionNames: string[];
  /** Regex patterns matched against the failure corpus (weaker evidence). */
  patterns: RegExp[];
}

export interface ModuleSummary {
  moduleKey: string;
  displayName: string;
  shortSummary: string;
  commonFailureModes?: string[];
  typicalDriftSignatures?: string[];
}

export interface SystemMap {
  modules: ModuleSummary[];
}

/**
 * A Pack carries ALL domain knowledge. Swap the pack, point the engine at a
 * different product — with zero engine changes. This is the decoupling contract.
 */
export interface Pack {
  id: string;
  signatures: SignatureDefinition[];
  /** signature key -> module keys that signature typically implicates. */
  signatureToModules: Record<string, string[]>;
  /** Constraints injected into every repair prompt (do-not-break rules). */
  baseConstraints: string[];
  /** Per-scope extra constraints. */
  scopeConstraints: Record<string, string[]>;
  /** Per-scope business/system impact copy. */
  scopeImpact: Record<string, string>;
  /** Per-signature repair goal copy. */
  signatureGoals: Record<string, string>;
  /** Per-signature impact copy. */
  signatureImpact: Record<string, string>;
  /** Domain-relevant diff keywords used to align changed files to behaviour. */
  diffKeywords: string[];
  systemMap: SystemMap;
  locks: LockDefinition[];
}

// ---- Evidence + report types ----------------------------------------------

export interface ChangedFile {
  path: string;
  changeType: "added" | "modified" | "deleted" | "renamed";
  additions?: number;
  deletions?: number;
  diffExcerpt?: string;
}

export interface GitContext {
  changedFiles?: ChangedFile[];
  diffSummary?: string | null;
  currentCommit?: string | null;
  lastPassingCommit?: string | null;
  /** Reserved for future runtime trace evidence. */
  executionTrace?: Record<string, unknown> | null;
}

export interface FailureSignatureMatch {
  key: string;
  label: string;
  description: string;
  score: number;
  evidence: string[];
}

export interface RankedFile {
  path: string;
  score: number;
  reason: string;
}

export interface RankedModule {
  name: string;
  score: number;
  reason: string;
}

export interface ConfidenceBreakdown {
  signatureMatch: number;
  lockOwnershipMatch: number;
  gitDiffMatch: number;
  diffKeywordAlignment: number;
  executionTraceMatch: number;
  capsApplied: string[];
}

export interface RepairPlan {
  goal: string;
  likelyFixAreas: string[];
  constraints: string[];
  regressionRisks: string[];
  rerunLocks: string[];
}

export interface DriftAnalysisReport {
  analysisStatus: AnalysisStatus;
  likelyCauseSummary: string;
  likelyFailureSignatures: string[];
  changedFiles: ChangedFile[];
  rankedFiles: RankedFile[];
  rankedModules: RankedModule[];
  repairPlan: RepairPlan;
  repairPrompt: string | null;
  promptMode: PromptMode;
  severity: DriftSeverity;
  confidence: number | null;
  confidenceTier: ConfidenceTier | null;
  confidenceBreakdown: ConfidenceBreakdown | null;
  confidenceExplanation: string | null;
  currentGitCommit: string | null;
  previousPassingGitCommit: string | null;
  notes: string[];
}
