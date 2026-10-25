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
 * Matching against these globs ignores case, because macOS and Windows
 * checkouts do, and agents read claude.md as readily as CLAUDE.md.
 */

/** Where coding agents read their instructions and tools from. Override with `context.files` in the policy. */
export const DEFAULT_CONTEXT_FILES = [
  // Instruction files, at any depth
  "**/AGENTS.md",
  "**/AGENTS.override.md",
  "**/AGENT.md",
  "**/CLAUDE.md",
  "**/CLAUDE.local.md",
  "**/GEMINI.md",
  "CONVENTIONS.md",
  // Claude Code: settings, hooks, skills, commands, agents
  "**/.claude/**",
  // MCP server configs
  "**/.mcp.json",
  ".vscode/mcp.json",
  ".vscode/settings.json",
  // Cursor
  ".cursorrules",
  ".cursor/**",
  // GitHub Copilot
  ".github/copilot-instructions.md",
  ".github/instructions/**",
  ".github/prompts/**",
  ".github/agents/**",
  ".github/chatmodes/**",
  // Other agents
  ".agents/**",
  ".gemini/**",
  ".codex/**",
  ".windsurfrules",
  ".windsurf/**",
  ".clinerules",
  ".clinerules/**",
  ".roo/**",
  ".amazonq/rules/**",
  ".junie/**",
];

export interface HiddenFinding {
  path: string;
  line: number;
  kind: "invisible_characters" | "html_comment" | "hidden_html" | "markdown_comment" | "blank_padding" | "image_reference";
  detail: string;
}

/**
 * Characters that are invisible, change direction, or can encode hidden text:
 * zero-width and joiners, bidirectional controls, Unicode tags, variation
 * selectors (both blocks, which can smuggle arbitrary bytes), soft hyphen,
 * Mongolian vowel separator, Arabic letter mark, line and paragraph
 * separators, Hangul fillers, and the byte-order mark away from the start.
 * Written as escapes so this file never contains what it looks for.
 */
const INVISIBLE =
  /[\u001B\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/** A line that renders as nothing: whitespace, invisible characters, &nbsp; or <br>. */
const RENDERS_EMPTY = /^(?:\s|\\|&nbsp;|&ensp;|&emsp;|&thinsp;|&#160;|&#xa0;|<br\s*\/?>|[\u00A0\u2800\u3164\u115F\u1160\uFFA0\u200B-\u200D\u2060\uFEFF])*$/i;

const BLANK_RUN = 20;

const isMarkdownish = (path: string) => /\.(md|mdc|mdx|markdown|txt)$/i.test(path) || !/\.[A-Za-z0-9]+$/.test(path.split("/").pop() ?? "");

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/**
 * Text an agent reads but a person reviewing the change on GitHub may not see.
 * Deterministic and model-free: it flags, it doesn't judge intent.
 *
 * Comments and images are only looked for in prose files (Markdown, text, no
 * extension), where GitHub renders them away. In JSON or YAML, GitHub shows the
 * raw text, so a comment there is visible to a reviewer.
 */
export function scanHiddenContent(path: string, text: string): HiddenFinding[] {
  const out: HiddenFinding[] = [];
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a leading byte-order mark is harmless
  const lines = body.split(/\r?\n/);
  let blankStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const found = [...new Set([...line.matchAll(INVISIBLE)].map((m) => `U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`))];
    if (found.length) {
      out.push({ path, line: i + 1, kind: "invisible_characters", detail: `invisible or direction-changing characters ${found.slice(0, 4).join(", ")}${found.length > 4 ? " and more" : ""}` });
    }
    if (RENDERS_EMPTY.test(line)) {
      if (blankStart < 0) blankStart = i;
    } else {
      if (blankStart >= 0 && i - blankStart >= BLANK_RUN) {
        out.push({ path, line: i + 1, kind: "blank_padding", detail: `${i - blankStart} empty-looking lines before this one push it out of view` });
      }
      blankStart = -1;
    }
  }
  if (isMarkdownish(path)) {
    // HTML comments, including one that is never closed: GitHub hides everything after <!--.
    const comment = /<!--([\s\S]*?)(?:-->|$)/g;
    for (let m = comment.exec(body); m; m = comment.exec(body)) {
      if (m[0].length === 0) { comment.lastIndex++; continue; }
      const closed = m[0].endsWith("-->");
      if (closed && m[1]!.trim() === "") continue;
      out.push({ path, line: lineOf(body, m.index), kind: "html_comment", detail: closed ? "HTML comment: GitHub doesn't render it, agents read it" : "unclosed HTML comment: GitHub hides everything after it" });
    }
    // Raw HTML GitHub strips or doesn't show: processing instructions, declarations, CDATA, script and style.
    const rawHtml = /<\?[\s\S]*?(?:\?>|$)|<![A-Za-z][^>]*>|<!\[CDATA\[|<(?:script|style|template|noscript)\b/gi;
    for (let m = rawHtml.exec(body); m; m = rawHtml.exec(body)) {
      if (m[0].length === 0) { rawHtml.lastIndex++; continue; }
      out.push({ path, line: lineOf(body, m.index), kind: "hidden_html", detail: "raw HTML GitHub doesn't display" });
    }
    // Link reference definitions render as nothing. Text can hide in one used as a comment ([//]: # (...)),
    // in its title ([x]: https://... "hidden text"), or in one no link ever uses. Flag all of these.
    const refDef = /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>]*>|\S+)?[ \t]*("[^"]*"|'[^']*'|\([^)]*\))?[ \t]*(\S.*)?$/gm;
    const withoutDefs = body.replace(refDef, "");
    const used = (label: string) => {
      const l = label.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      // [text][label], [label][], or the shortcut [label] not followed by ( or [
      return new RegExp(`\\]\\[${l}\\]|\\[${l}\\]\\[\\]|\\[${l}\\](?![(\\[])`, "i").test(withoutDefs);
    };
    for (let m = refDef.exec(body); m; m = refDef.exec(body)) {
      const [, label, dest, title, trailing] = m;
      const commentLike = !dest || /^(?:#|<>)/.test(dest) || label!.trim().startsWith("//");
      const why = commentLike
        ? "Markdown reference used as a comment"
        : title || trailing
          ? "Markdown reference with a title"
          : !used(label!)
            ? "Markdown reference no link uses"
            : null;
      if (why) out.push({ path, line: lineOf(body, m.index), kind: "markdown_comment", detail: `${why}: GitHub doesn't render it, agents read it` });
    }
    // Images: inline, reference-style, and HTML.
    const image = /!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])|<img\b[^>]*>|<picture\b|<svg\b/gi;
    for (let m = image.exec(body); m; m = image.exec(body)) {
      out.push({ path, line: lineOf(body, m.index), kind: "image_reference", detail: "image in agent instructions: reviewers rarely open it, agents may read text inside it" });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
