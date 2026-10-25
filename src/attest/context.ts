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
 * Markdown is parsed with `marked` to find link definitions, which can sit in
 * many places a hand-written pattern would miss.
 * Matching against these globs ignores case, because macOS and Windows
 * checkouts do, and agents read claude.md as readily as CLAUDE.md.
 */

/** Where coding agents read their instructions and tools from. Override with `context.files` in the policy. */
import { Lexer, Tokenizer } from "marked";

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
/** Changed context files larger than this are refused rather than scanned. */
export const MAX_SCAN = 512 * 1024;
/** Enough to refuse and to show the reader; stops a file of a million comments costing a million line counts. */
const MAX_FINDINGS = 50;

const isMarkdownish = (path: string) => /\.(md|mdc|mdx|markdown|txt)$/i.test(path) || !/\.[A-Za-z0-9]+$/.test(path.split("/").pop() ?? "");

/** CommonMark matches labels by Unicode case fold: [ß] and [SS] are the same label. Upper then lower is close enough in JS. */
const normLabel = (l: string) => l.trim().replace(/\s+/g, " ").toUpperCase().toLowerCase();

type BlockToken = { type: string; raw: string; tokens?: BlockToken[]; items?: { tokens?: BlockToken[] }[] };

/**
 * Every link reference definition in a Markdown document, in order, including
 * repeats of a label (Markdown keeps only the first, so later ones render as
 * nothing at all). Block-level parsing only: definitions are blocks, and
 * skipping inline parsing keeps a hostile file from stalling the gate. Every
 * step here is linear in the size of the file.
 */
export function linkDefinitions(input: string): { label: string; href: string; title?: string; used: boolean; duplicate: boolean; commentLike: boolean; line: number }[] {
  const body = input.replace(/\r\n?/g, "\n"); // what marked's own entry point does first
  const found: { label: string; href: string; title?: string; raw: string }[] = [];
  // Record each definition as the parser reads it, through the public Tokenizer option.
  const tokenizer = new Tokenizer();
  const def = tokenizer.def.bind(tokenizer);
  tokenizer.def = (src: string) => {
    const t = def(src);
    if (t) found.push({ label: t.tag, href: t.href ?? "", ...(t.title ? { title: t.title } : {}), raw: t.raw });
    return t;
  };
  let tokens: BlockToken[];
  try {
    tokens = new Lexer({ tokenizer }).blockTokens(body, []) as unknown as BlockToken[];
  } catch {
    return [];
  }

  // The text a reader sees links in: every block except definitions and code, with inline code and link
  // destinations removed. A label written only inside code, or inside a URL, isn't a use.
  const visible: string[] = [];
  const walk = (list: BlockToken[] | undefined) => {
    for (const t of list ?? []) {
      if (t.type === "def" || t.type === "code" || t.type === "space") continue;
      if (t.type === "blockquote") walk(t.tokens);
      else if (t.type === "list") for (const item of t.items ?? []) walk(item.tokens);
      else visible.push(t.raw);
    }
  };
  walk(tokens);
  const text = visible
    .join("\n")
    .replace(/(`+)[\s\S]*?\1/g, " ")
    .replace(/\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "]");
  const used = new Set<string>();
  const ref = /\[((?:\\.|[^\]\\\n])+)\](?:\[((?:\\.|[^\]\\\n])*)\])?/g;
  for (let m = ref.exec(text); m; m = ref.exec(text)) {
    used.add(normLabel(m[2] ? m[2] : m[1]!));
    if (m[2] !== undefined) used.add(normLabel(m[1]!)); // [label][] (collapsed) uses its text
  }

  // Line numbers, found by walking forward through the text once.
  let cursor = 0;
  let line = 1;
  const lineAt = (raw: string) => {
    const at = body.indexOf(raw.trimStart().split("\n")[0]!, cursor);
    if (at < 0) return line;
    for (let i = cursor; i < at; i++) if (body.charCodeAt(i) === 10) line++;
    cursor = at;
    return line;
  };

  const seen = new Set<string>();
  return found.map((f) => {
    const key = normLabel(f.label);
    const duplicate = seen.has(key);
    seen.add(key);
    const isUsed = used.has(key);
    return {
      label: f.label,
      href: f.href,
      ...(f.title ? { title: f.title } : {}),
      used: isUsed,
      duplicate,
      line: lineAt(f.raw),
      commentLike: f.href === "" || f.href === "#" || f.href === "<>" || f.label.trim().startsWith("//") || (f.href.startsWith("#") && !isUsed),
    };
  });
}

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
  if (text.length > MAX_SCAN) {
    return [{ path, line: 1, kind: "invisible_characters", detail: `over ${MAX_SCAN / 1024} KB, too large to check. Agent instructions this long can't be reviewed by a person either` }];
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a leading byte-order mark is harmless
  const lines = body.split(/\r?\n/);
  let blankStart = -1;
  for (let i = 0; i < lines.length && out.length < MAX_FINDINGS; i++) {
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
      if (out.length >= MAX_FINDINGS) break;
      if (m[0].length === 0) { comment.lastIndex++; continue; }
      const closed = m[0].endsWith("-->");
      if (closed && m[1]!.trim() === "") continue;
      out.push({ path, line: lineOf(body, m.index), kind: "html_comment", detail: closed ? "HTML comment: GitHub doesn't render it, agents read it" : "unclosed HTML comment: GitHub hides everything after it" });
    }
    // Raw HTML GitHub strips or doesn't show: processing instructions, declarations, CDATA, script and style.
    const rawHtml = /<\?|<![A-Za-z]|<!\[CDATA\[|<(?:script|style|template|noscript)\b/gi; // the opening is enough: closed or not, GitHub hides it
    for (let m = rawHtml.exec(body); m; m = rawHtml.exec(body)) {
      if (out.length >= MAX_FINDINGS) break;
      if (m[0].length === 0) { rawHtml.lastIndex++; continue; }
      out.push({ path, line: lineOf(body, m.index), kind: "hidden_html", detail: "raw HTML GitHub doesn't display" });
    }
    // Link reference definitions render as nothing, wherever they sit (a quote, a list, after an escaped
    // bracket, with the title on the next line). A Markdown parser finds them all. Flag one used as a comment
    // ([//]: # (...)), one with a title (shown only as a tooltip), or one no link uses.
    for (const d of linkDefinitions(body)) {
      if (out.length >= MAX_FINDINGS) break;
      const why = d.duplicate
        ? "Markdown reference defined again: only the first counts, this one renders as nothing"
        : d.commentLike
        ? "Markdown reference used as a comment"
        : d.title
          ? "Markdown reference with a title, shown only on hover"
          : !d.used
            ? "Markdown reference no link uses"
            : null;
      if (why) out.push({ path, line: d.line, kind: "markdown_comment", detail: `${why}: GitHub doesn't render it, agents read it` });
    }
    // Inline link titles show only on hover, like a definition's title.
    const inlineTitle = /\]\(\s*(?:<[^>\n]*>|[^\s()]+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*\)/g;
    for (let m = inlineTitle.exec(body); m; m = inlineTitle.exec(body)) {
      if (out.length >= MAX_FINDINGS) break;
      out.push({ path, line: lineOf(body, m.index), kind: "markdown_comment", detail: "link title, shown only on hover: GitHub doesn't render it, agents read it" });
    }
    // Images: inline, reference-style, and HTML.
    const image = /!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])|<img\b[^>]*>|<picture\b|<svg\b/gi;
    for (let m = image.exec(body); m; m = image.exec(body)) {
      if (out.length >= MAX_FINDINGS) break;
      out.push({ path, line: lineOf(body, m.index), kind: "image_reference", detail: "image in agent instructions: reviewers rarely open it, agents may read text inside it" });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
