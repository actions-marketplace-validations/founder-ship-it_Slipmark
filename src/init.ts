/**
 * `slipmark init`: wire Slipmark into a repository in one command.
 *
 * Writes three things, never overwriting anything it did not write itself:
 *   1. `.slipmark/attestations/.gitkeep` so the directory exists and is committed.
 *   2. `.github/workflows/slipmark.yml`, a report-only gate (it warns, it does not
 *      fail the build) because a fresh repo has no attestations yet and an empty
 *      gate refuses. Flip `fail-on-refusal` once your agents are attesting.
 *   3. An instructions block for coding agents, in AGENTS.md (read by Codex,
 *      Cursor, Copilot and others) and in CLAUDE.md, Cursor rules or Copilot
 *      instructions when those already exist. The block is fenced with markers
 *      so re-running init updates it in place instead of duplicating it.
 *
 * `planInit` is pure (it reads, never writes) so the plan can be shown with
 * `--dry-run` and tested without touching disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const BLOCK_BEGIN = "<!-- slipmark:begin -->";
export const BLOCK_END = "<!-- slipmark:end -->";

export interface InitOptions {
  root?: string;
  /** Tag or ref of the Action to pin in the workflow, e.g. "v0.3.0". */
  actionRef: string;
  workflow?: boolean;
  agents?: boolean;
  /** Overwrite an existing workflow file that Slipmark did not write. */
  force?: boolean;
}

export type InitAction = "create" | "update" | "skip";

export interface PlannedFile {
  /** Path relative to root, forward slashes. */
  path: string;
  action: InitAction;
  reason: string;
  content: string;
}

export function agentBlock(): string {
  return `${BLOCK_BEGIN}
## Slipmark: prove what you checked

This repository gates merges with [Slipmark](https://github.com/founder-ship-it/Slipmark).
A verdict only counts if it is bound to the exact files it was about.

Whenever you give a verdict (a review passed, an audit cleared, tests pass, a spec approved), record it:

\`\`\`bash
npx slipmark attest --by <your-role> --verdict pass \\
  --subject <file you read> --subject <another file you read> \\
  --note "<one line on what you checked>"
\`\`\`

- List every file the verdict is based on, not only the files you changed.
- If it does not pass, use \`--verdict fail\` or \`--verdict blocked\`. Never attest \`pass\` for a file you did not read.
- Commit the new file in \`.slipmark/attestations/\` together with your change.
- If a file changes after you attested it, read it again and attest again. The gate refuses stale verdicts.
- Never edit or delete attestation files by hand.
- Check before you hand over: \`npx slipmark verify\` (exit 0 means every verdict matches the files as they are now).
${BLOCK_END}
`;
}

export function workflowYaml(actionRef: string): string {
  return `# Written by \`slipmark init\`. Slipmark refuses to ship when an agent's verdict
# is about different files from the ones you are merging.
# https://github.com/founder-ship-it/Slipmark
name: Slipmark

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: founder-ship-it/Slipmark@${actionRef}
        with:
          # Report-only while your agents start attesting: refusals show as a
          # warning instead of failing the build. Set to "true" to enforce.
          fail-on-refusal: "false"
          # Files that must carry a passing, current verdict. One per line.
          # require: |
          #   specs/your-feature.md
`;
}

function read(abs: string): string | null {
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/** Insert or replace the marked block. Returns null when nothing would change. */
export function upsertBlock(existing: string | null, block: string): string | null {
  if (existing === null) return block;
  const start = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  if (start >= 0 && end > start) {
    const tail = existing.slice(end + BLOCK_END.length).replace(/^\r?\n/, "");
    const next = existing.slice(0, start) + block + tail;
    return next === existing ? null : next;
  }
  const sep = existing.length === 0 ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block;
}

function cursorRule(block: string): string {
  return `---
description: Slipmark attestation rules for agent verdicts
alwaysApply: true
---

${block}`;
}

export function planInit(opts: InitOptions): PlannedFile[] {
  const root = resolve(opts.root ?? process.cwd());
  const plan: PlannedFile[] = [];
  const at = (p: string) => join(root, p);

  // 1. Attestation directory.
  const keep = ".slipmark/attestations/.gitkeep";
  plan.push(
    existsSync(at(keep)) || existsSync(at(".slipmark/attestations"))
      ? { path: keep, action: "skip", reason: "attestation directory already exists", content: "" }
      : { path: keep, action: "create", reason: "attestation directory, committed with the repo", content: "" },
  );

  // 2. Workflow.
  if (opts.workflow !== false) {
    const wf = ".github/workflows/slipmark.yml";
    const existing = read(at(wf));
    const content = workflowYaml(opts.actionRef);
    if (existing === null) {
      plan.push({ path: wf, action: "create", reason: "report-only gate on pull requests", content });
    } else if (existing === content) {
      plan.push({ path: wf, action: "skip", reason: "workflow already up to date", content });
    } else if (existing.startsWith("# Written by `slipmark init`") || opts.force) {
      plan.push({ path: wf, action: "update", reason: opts.force ? "--force" : "refreshing the workflow init wrote", content });
    } else {
      plan.push({ path: wf, action: "skip", reason: "a slipmark.yml you wrote already exists (use --force to replace it)", content });
    }
  }

  // 3. Agent instructions.
  if (opts.agents !== false) {
    const block = agentBlock();
    const targets: { path: string; always: boolean; wrap?: (b: string) => string }[] = [
      { path: "AGENTS.md", always: true },
      { path: "CLAUDE.md", always: false },
      { path: ".github/copilot-instructions.md", always: false },
    ];
    for (const t of targets) {
      const existing = read(at(t.path));
      if (existing === null && t.path === "CLAUDE.md" && existsSync(at(".claude"))) {
        // A Claude Code project without CLAUDE.md: point it at AGENTS.md rather than duplicating the block.
        plan.push({ path: t.path, action: "create", reason: "points Claude Code at AGENTS.md", content: "@AGENTS.md\n" });
        continue;
      }
      if (existing === null && !t.always) continue;
      if (t.path === "CLAUDE.md" && existing !== null && /^@AGENTS\.md\s*$/m.test(existing) && !existing.includes(BLOCK_BEGIN)) {
        plan.push({ path: t.path, action: "skip", reason: "already imports AGENTS.md", content: existing });
        continue;
      }
      const next = upsertBlock(existing, block);
      if (next === null) plan.push({ path: t.path, action: "skip", reason: "agent instructions already up to date", content: existing ?? "" });
      else plan.push({ path: t.path, action: existing === null ? "create" : "update", reason: "agent instructions for attesting verdicts", content: next });
    }
    // Cursor reads rules from .cursor/rules; only add one when the project uses Cursor.
    if (existsSync(at(".cursor"))) {
      const p = ".cursor/rules/slipmark.mdc";
      const content = cursorRule(block);
      const existing = read(at(p));
      plan.push({ path: p, action: existing === null ? "create" : existing === content ? "skip" : "update", reason: "Cursor rule for attesting verdicts", content });
    }
  }
  return plan;
}

export function applyInit(root: string, plan: PlannedFile[]): void {
  for (const f of plan) {
    if (f.action === "skip") continue;
    const abs = join(resolve(root), f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
  }
}
