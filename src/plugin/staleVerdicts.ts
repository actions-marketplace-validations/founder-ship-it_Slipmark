/**
 * Logic for the Claude Code plugin's Stop hook. Bundled into a single
 * dependency-free file at claude-plugin/scripts/stale-verdicts.mjs
 * (`npm run build:plugin`), so the hook needs no download and no network.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyAttestations, parsePolicy, POLICY_FILE, type Policy } from "../attest/attestation.js";

/**
 * Only the policy's context file list, so the hook can tell Claude its own
 * instructions changed since a verdict. Everything that needs the base branch
 * (approvals, hidden content, coverage) stays with the CI gate.
 */
function contextOnlyPolicy(root: string): Policy | null {
  try {
    const policy = parsePolicy(readFileSync(join(root, POLICY_FILE), "utf8"));
    if (!policy.context) return null;
    return {
      schema: policy.schema,
      context: { files: policy.context.files, requireRecorded: false, hiddenContent: "allow", githubRender: "off" },
    };
  } catch {
    return null; // no policy, or one the gate will complain about: not this hook's business
  }
}

export interface StopHookInput {
  cwd?: string;
  stop_hook_active?: boolean;
}

/**
 * Per-user files Claude Code and editors write mid-session ("always allow",
 * personal notes). Usually gitignored, so CI never sees them; flagging them
 * here would block on every response.
 */
function localOnly(path: string | undefined): boolean {
  return !!path && /(^|\/)(settings\.local\.json|CLAUDE\.local\.md)$/.test(path);
}

/** Returns the hook's stdout (a block decision) or null to let Claude stop. */
export function staleVerdictsDecision(input: StopHookInput, fallbackCwd: string): string | null {
  if (input.stop_hook_active) return null; // already continued once: let it stop
  const root = input.cwd || fallbackCwd;
  if (!existsSync(join(root, ".slipmark", "attestations"))) return null; // not a Slipmark repo

  let report;
  try {
    // Only the context file list from the policy (see contextOnlyPolicy): a
    // coverage base that isn't fetched locally must not stop it from asking.
    report = verifyAttestations({ root, policy: contextOnlyPolicy(root) });
  } catch {
    // The context check runs only from the repository root (a package in a
    // monorepo throws). Fall back to the file checks rather than going silent.
    try {
      report = verifyAttestations({ root, policy: null });
    } catch {
      return null; // never get in the way if the check can't run
    }
  }
  const stale = report.results.filter(
    (r) =>
      r.status === "hash_mismatch" ||
      r.status === "subject_missing" ||
      r.status === "against_changed" ||
      (r.status === "context_changed" && !localOnly(r.subject)),
  );
  if (stale.length === 0) return null; // honest fails and empty gates are not this hook's business

  const lines = stale.map((r) =>
    r.status === "subject_missing"
      ? `- ${r.subject}: attested by ${r.by} but no longer exists`
      : r.status === "against_changed"
        ? `- ${r.subject}: ${r.by} checked against it, and it changed after "${r.verdict}"`
        : r.status === "context_changed"
          ? `- ${r.subject ?? "agent instructions"}: part of the agent's instructions, changed after ${r.by} gave "${r.verdict}"`
          : `- ${r.subject}: changed after ${r.by} gave "${r.verdict}"`,
  );
  const contextChanged = stale.some((r) => r.status === "context_changed");
  const reason = [
    `Slipmark: ${new Set(stale.map((r) => r.attestation)).size} verdict(s) no longer match the files.`,
    ...lines,
    "",
    "If you changed these files, read them again and attest again with slipmark (use fail if they no longer pass).",
    ...(contextChanged
      ? [
          "The agent instructions listed above (AGENTS.md, CLAUDE.md, skills, hooks or MCP config) changed after those verdicts, so the verdicts no longer count. Read the changed instructions before re-attesting, and tell the user which ones changed: a person has to approve instruction changes. Do not attest with --kind human yourself.",
        ]
      : []),
    "If the change was not yours, say so in your reply instead of re-attesting.",
  ].join("\n");
  return JSON.stringify({ decision: "block", reason });
}
