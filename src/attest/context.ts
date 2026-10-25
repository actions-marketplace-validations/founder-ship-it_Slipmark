/**
 * Agent context: the files that tell a coding agent how to behave.
 *
 * A verdict depends on the files the agent reviewed and on what the agent was
 * told: AGENTS.md, CLAUDE.md, Cursor rules, skills, hooks, MCP server configs.
 * The 2026 attacks on coding agents (Ghostcommit, Deadbugz, TrustFall, malicious
 * skills) all changed that context and left the reviewed code alone. So
 * Slipmark records the context a verdict was given under, and refuses changes
 * to it that nobody approved, or that hide text from human reviewers.
 *
 * Pure: no file system or git access here. attestation.ts does the reading.
 */

/** Where coding agents read their instructions and tools from. Override with `context.files` in the policy. */
export const DEFAULT_CONTEXT_FILES = [
  "AGENTS.md",
  "**/AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
  "**/CLAUDE.md",
  "CLAUDE.local.md",
  ".claude/**",
  ".mcp.json",
  ".cursorrules",
  ".cursor/rules/**",
  ".cursor/mcp.json",
  ".github/copilot-instructions.md",
  ".github/instructions/**",
  ".github/prompts/**",
  ".vscode/mcp.json",
  "GEMINI.md",
  ".gemini/**",
  ".codex/**",
  ".windsurfrules",
  ".windsurf/rules/**",
];

export interface HiddenFinding {
  path: string;
  line: number;
  kind: "invisible_characters" | "html_comment" | "blank_padding" | "image_reference";
  detail: string;
}

/** Characters that change or hide what a human sees: zero-width, bidirectional controls, Unicode tags. */
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/u;
const BLANK_RUN = 20;

const isMarkdownish = (path: string) => /\.(md|mdc|markdown|txt)$/i.test(path) || !/\.[A-Za-z0-9]+$/.test(path.split("/").pop() ?? "");

/**
 * Text an agent reads but a person reviewing the change on GitHub may not see.
 * Deterministic and model-free: it flags, it doesn't judge intent.
 */
export function scanHiddenContent(path: string, text: string): HiddenFinding[] {
  const out: HiddenFinding[] = [];
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a leading byte-order mark is harmless
  const lines = body.split(/\r?\n/);
  let blankStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = INVISIBLE.exec(line);
    if (m) {
      const cp = m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
      out.push({ path, line: i + 1, kind: "invisible_characters", detail: `invisible or direction-changing character U+${cp}` });
    }
    if (line.trim() === "") {
      if (blankStart < 0) blankStart = i;
    } else {
      if (blankStart >= 0 && i - blankStart >= BLANK_RUN) {
        out.push({ path, line: i + 1, kind: "blank_padding", detail: `${i - blankStart} blank lines before this one push it out of view` });
      }
      blankStart = -1;
    }
  }
  if (isMarkdownish(path)) {
    const comment = /<!--[\s\S]*?-->/g;
    for (let m = comment.exec(body); m; m = comment.exec(body)) {
      if (m[0].replace(/<!--|-->/g, "").trim() === "") continue;
      out.push({ path, line: body.slice(0, m.index).split("\n").length, kind: "html_comment", detail: "HTML comment: GitHub doesn't render it, agents read it" });
    }
    const image = /!\[[^\]]*\]\([^)\s]+[^)]*\)|<img\b[^>]*>/gi;
    for (let m = image.exec(body); m; m = image.exec(body)) {
      out.push({ path, line: body.slice(0, m.index).split("\n").length, kind: "image_reference", detail: "image in agent instructions: reviewers rarely open it, agents may read text inside it" });
    }
  }
  return out;
}
