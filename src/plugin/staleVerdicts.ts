/**
 * Logic for the Claude Code plugin's Stop hook. Bundled into a single
 * dependency-free file at claude-plugin/scripts/stale-verdicts.mjs
 * (`npm run build:plugin`), so the hook needs no download and no network.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { verifyAttestations } from "../attest/attestation.js";

export interface StopHookInput {
  cwd?: string;
  stop_hook_active?: boolean;
}

/** Returns the hook's stdout (a block decision) or null to let Claude stop. */
export function staleVerdictsDecision(input: StopHookInput, fallbackCwd: string): string | null {
  if (input.stop_hook_active) return null; // already continued once: let it stop
  const root = input.cwd || fallbackCwd;
  if (!existsSync(join(root, ".slipmark", "attestations"))) return null; // not a Slipmark repo

  let report;
  try {
    report = verifyAttestations({ root });
  } catch {
    return null; // never get in the way if the check can't run
  }
  const stale = report.results.filter((r) => r.status === "hash_mismatch" || r.status === "subject_missing");
  if (stale.length === 0) return null; // honest fails and empty gates are not this hook's business

  const lines = stale.map((r) =>
    r.status === "hash_mismatch"
      ? `- ${r.subject}: changed after ${r.by} gave "${r.verdict}"`
      : `- ${r.subject}: attested by ${r.by} but no longer exists`,
  );
  const reason = [
    `Slipmark: ${stale.length} verdict(s) no longer match the files.`,
    ...lines,
    "",
    "If you changed these files, read them again and attest again with slipmark (use fail if they no longer pass).",
    "If the change was not yours, say so in your reply instead of re-attesting.",
  ].join("\n");
  return JSON.stringify({ decision: "block", reason });
}
