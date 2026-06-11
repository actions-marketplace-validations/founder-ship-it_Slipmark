/**
 * Dashboard data model.
 *
 * This is the shape the future cloud API will return. Today it is persisted as a
 * flat JSON history file (the "backend" is a file); swapping that for a database
 * + API is the only thing standing between this and the hosted product.
 */
import type { VerificationRun } from "../engine/runner.js";

export interface LockSummary {
  key: string;
  name: string;
  scope: string;
  status: "pass" | "drift" | "error" | "skipped";
  confidence: number | null;
  confidenceTier: string | null;
  severity: string | null;
  signatures: string[];
  confidenceExplanation: string | null;
  repairPrompt: string | null;
}

export interface RunSummary {
  id: string;
  timestamp: string;
  packId: string;
  total: number;
  passed: number;
  drifted: number;
  errored: number;
  locks: LockSummary[];
}

export interface DashboardData {
  project: string;
  generatedAt: string;
  /** Newest first. */
  runs: RunSummary[];
}

/** Convert an engine VerificationRun into a stored RunSummary. */
export function summariseRun(run: VerificationRun, opts?: { timestamp?: string; project?: string }): RunSummary {
  const timestamp = opts?.timestamp ?? new Date().toISOString();
  return {
    id: `run_${timestamp.replace(/[^0-9]/g, "").slice(0, 14)}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp,
    packId: run.packId,
    total: run.total,
    passed: run.passed,
    drifted: run.drifted,
    errored: run.errored,
    locks: run.outcomes.map((o) => ({
      key: o.key,
      name: o.name,
      scope: o.scope,
      status: o.result.status,
      confidence: o.analysis?.confidence ?? null,
      confidenceTier: o.analysis?.confidenceTier ?? null,
      severity: o.analysis?.severity ?? null,
      signatures: o.analysis?.likelyFailureSignatures ?? [],
      confidenceExplanation: o.analysis?.confidenceExplanation ?? null,
      repairPrompt: o.analysis?.repairPrompt ?? null,
    })),
  };
}

/** Prepend a run to history (newest first), capping length. */
export function appendRun(history: DashboardData | null, run: RunSummary, project: string, cap = 50): DashboardData {
  const runs = [run, ...(history?.runs ?? [])].slice(0, cap);
  return { project: history?.project ?? project, generatedAt: new Date().toISOString(), runs };
}
