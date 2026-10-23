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
    // No policy: this hook only asks about stale verdicts, and a coverage base
    // that isn't fetched locally must not stop it from asking.
    report = verifyAttestations({ root, policy: null });
  } catch {
    return null; // never get in the way if the check can't run
  }
  const stale = report.results.filter(
    (r) => r.status === "hash_mismatch" || r.status === "subject_missing" || r.status === "against_changed",
  );
  if (stale.length === 0) return null; // honest fails and empty gates are not this hook's business

  const lines = stale.map((r) =>
    r.status === "subject_missing"
      ? `- ${r.subject}: attested by ${r.by} but no longer exists`
      : r.status === "against_changed"
        ? `- ${r.subject}: ${r.by} checked against it, and it changed after "${r.verdict}"`
        : `- ${r.subject}: changed after ${r.by} gave "${r.verdict}"`,
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
