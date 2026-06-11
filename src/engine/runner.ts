/**
 * Lock runner — executes every lock in a pack, and for each drift, builds an
 * analysis report. Pure orchestration; no I/O.
 */
import type { DriftAnalysisReport, GitContext, LockResult, Pack } from "../types.js";
import { buildDriftAnalysisReport } from "./analyze.js";

export interface LockRunOutcome {
  key: string;
  name: string;
  scope: string;
  result: LockResult;
  analysis: DriftAnalysisReport | null;
}

export interface VerificationRun {
  packId: string;
  total: number;
  passed: number;
  drifted: number;
  errored: number;
  outcomes: LockRunOutcome[];
}

export function runPack(pack: Pack, gitContext?: GitContext | null): VerificationRun {
  const outcomes: LockRunOutcome[] = [];
  let passed = 0;
  let drifted = 0;
  let errored = 0;

  for (const lock of pack.locks) {
    let result: LockResult;
    try {
      result = lock.run();
    } catch (e) {
      result = { status: "error", message: e instanceof Error ? e.message : String(e), failedAssertions: [] };
    }

    let analysis: DriftAnalysisReport | null = null;
    if (result.status === "drift" || result.status === "error") {
      analysis = buildDriftAnalysisReport({
        pack,
        lock,
        registry: pack.locks,
        failedItem: { status: result.status, message: result.message, failedAssertions: result.failedAssertions },
        gitContext,
      });
    }

    if (result.status === "pass") passed++;
    else if (result.status === "drift") drifted++;
    else if (result.status === "error") errored++;

    outcomes.push({ key: lock.key, name: lock.name, scope: lock.scope, result, analysis });
  }

  return { packId: pack.id, total: pack.locks.length, passed, drifted, errored, outcomes };
}
