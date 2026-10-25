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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ALLOWED_COMMENTS } from "./markdownSubset.js";

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
  kind: "invisible_characters" | "html_comment" | "hidden_html" | "markdown_comment" | "blank_padding" | "image_reference" | "not_plain_markdown";
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
/** Most a single file's scan may take before it's refused as too complex to check. */
const SCAN_BUDGET_MS = 3000;
/** Enough to refuse and to show the reader; stops a file of a million comments costing a million line counts. */
const MAX_FINDINGS = 50;

/**
 * How GitHub shows a file, by extension. Markup it renders other than Markdown
 * (reStructuredText, AsciiDoc, Org, ...) has its own hidden comments that
 * Slipmark doesn't parse, so in agent context it's refused. Data and code are
 * shown as raw text, where comments are visible. Anything else, including no
 * extension and every Markdown variant, is treated as Markdown: the safe side.
 */
const OTHER_MARKUP = /\.(rst|rest|adoc|asciidoc|asc|org|textile|rdoc|pod|creole|mediawiki|wiki|rmd|svg|ipynb)$/i;
const SHOWN_RAW = /\.(json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|lock|csv|tsv|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|mts|cts|tsx|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|pl|sh|bash|zsh|fish|ps1|bat|cmd|sql|lua|r|dart|scala|ex|exs|erl|hs|ml|clj|vue|svelte|tf|hcl|gradle|properties|dockerfile|gitignore|gitattributes|editorconfig)$/i;
export const isMarkdownish = (path: string) => !SHOWN_RAW.test(path) && !OTHER_MARKUP.test(path);

/** CommonMark matches labels by Unicode case fold: [ss] and [SS] are the same label. Upper then lower is close enough in JS. */
const normLabel = (l: string) => l.trim().replace(/\s+/g, " ").toUpperCase().toLowerCase();

/**
 * Every link reference definition in a Markdown document, in order, including
 * repeats of a label. A definition never renders itself, and working out which
 * ones a link displays means copying GitHub's inline parser exactly, which a
 * review showed is a losing game. So in agent context every definition is
 * flagged; inline links ([text](url)) are unaffected.
 *
 * Block-level parsing only (definitions are blocks), with line endings
 * normalised first, as marked's own entry point does. Linear in the file size.
 */
export function linkDefinitions(input: string): { label: string; href: string; title?: string; duplicate: boolean; commentLike: boolean; line: number; endLine: number }[] {
  const body = input.replace(/\r\n?/g, "\n");
  const found: { label: string; href: string; title?: string; raw: string }[] = [];
  // Record each definition as the parser reads it, through the public Tokenizer option.
  const tokenizer = new Tokenizer();
  const def = tokenizer.def.bind(tokenizer);
  tokenizer.def = (src: string) => {
    const t = def(src);
    if (t) found.push({ label: t.tag, href: t.href ?? "", ...(t.title ? { title: t.title } : {}), raw: t.raw });
    return t;
  };
  try {
    new Lexer({ tokenizer }).blockTokens(body, []);
  } catch {
    return [];
  }
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
    const start = lineAt(f.raw);
    return {
      label: f.label,
      href: f.href,
      ...(f.title ? { title: f.title } : {}),
      duplicate,
      line: start,
      endLine: start + (f.raw.replace(/\n+$/, "").match(/\n/g)?.length ?? 0),
      commentLike: f.href === "" || f.href.startsWith("#") || f.href === "<>" || f.label.trim().startsWith("//"),
    };
  });
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/**
 * The allow-list check: parse the file as GitHub Markdown and refuse anything
 * outside the plain subset in markdownSubset.ts. The parser runs in a child
 * process with a time limit, because some inputs make Markdown parsers slow;
 * running out of time, or failing to run, refuses the file. Returns the text
 * the subset displays, for comparing with GitHub's own rendering.
 */
export function checkMarkdownSubset(path: string, text: string, budgetMs: number = SCAN_BUDGET_MS): { findings: HiddenFinding[]; visible: string } {
  const worker = fileURLToPath(new URL("./markdownWorker.js", import.meta.url));
  const r = spawnSync(process.execPath, [worker], { input: JSON.stringify({ text }), encoding: "utf8", timeout: budgetMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    const why = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || r.signal ? "too complex to check in time" : "couldn't be checked";
    return { findings: [{ path, line: 1, kind: "not_plain_markdown", detail: why }], visible: "" };
  }
  const out = JSON.parse(r.stdout) as { unsupported: { line: number; detail: string }[]; visible: string };
  return { findings: out.unsupported.map((u) => ({ path, line: u.line, kind: "not_plain_markdown" as const, detail: u.detail })), visible: out.visible };
}

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
  // Every pattern here is linear, but a time budget backstops any future slow case: refuse, never stall.
  const started = Date.now();
  const overBudget = () => Date.now() - started > SCAN_BUDGET_MS;
  const tooSlow = () => [...out, { path, line: 1, kind: "hidden_html" as const, detail: "too complex to check in time" }];
  if (OTHER_MARKUP.test(path)) {
    return [{ path, line: 1, kind: "hidden_html", detail: "a markup format GitHub renders, with its own hidden comments Slipmark can't check. Write agent instructions in Markdown" }];
  }
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
  if (overBudget()) return tooSlow();
  if (isMarkdownish(path)) {
    // HTML comments, including one that is never closed: GitHub hides everything after <!--.
    const comment = /<!--([\s\S]*?)(?:-->|$)/g;
    for (let m = comment.exec(body); m; m = comment.exec(body)) {
      if (out.length >= MAX_FINDINGS) break;
      if (m[0].length === 0) { comment.lastIndex++; continue; }
      const closed = m[0].endsWith("-->");
      if (closed && m[1]!.trim() === "") continue;
      if (closed && ALLOWED_COMMENTS.has(m[0])) continue;
      out.push({ path, line: lineOf(body, m.index), kind: "html_comment", detail: closed ? "HTML comment: GitHub doesn't render it, agents read it" : "unclosed HTML comment: GitHub hides everything after it" });
    }
    // Raw HTML of any kind: GitHub strips some of it (script, style, declarations), never shows attributes
    // (title, data-*, value), and collapses or hides more. Telling which is which means copying GitHub's
    // sanitiser, so every tag opener is flagged: complete, linear. Agent instructions don't need HTML.
    const rawHtml = /<\?|<!(?:[A-Za-z]|\[CDATA\[)|<\/?[A-Za-z]/g;
    for (let m = rawHtml.exec(body); m; m = rawHtml.exec(body)) {
      if (out.length >= MAX_FINDINGS) break;
      out.push({ path, line: lineOf(body, m.index), kind: "hidden_html", detail: "raw HTML: GitHub hides attributes and some tags, agents read them. Write agent instructions in plain Markdown" });
    }
    if (overBudget()) return tooSlow();
    // Link reference definitions render as nothing, and text can hide in the label, the address or the title.
    // Every one in a changed context file is flagged; write links inline instead. Found two ways: the parser
    // (labels across lines, escapes), and a deliberately broad line check for anything that looks like one,
    // because parsers disagree at the edges (tabs, lazy quote continuation). Over-flagging is the safe side.
    const flagged = new Set<number>();
    for (const d of linkDefinitions(body)) {
      if (out.length >= MAX_FINDINGS) break;
      for (let l = d.line; l <= d.endLine; l++) flagged.add(l);
      const why = d.label.startsWith("^")
        ? "footnote definition: GitHub doesn't show it unless something points to it, agents read it"
        : d.duplicate
        ? "Markdown link definition repeating a label: it renders as nothing at all"
        : d.commentLike
          ? "Markdown link definition used as a comment"
          : "Markdown link definition: it doesn't render, so a reviewer can't see what it says. Write the link inline instead";
      out.push({ path, line: d.line, kind: "markdown_comment", detail: why });
    }
    if (overBudget()) return tooSlow();
    // Every link or footnote definition contains the two characters "]:" (the label's closing bracket, then
    // the colon), however the label is split or wherever it sits. So every "]:" is flagged: a complete
    // over-approximation, linear, with no guessing about Markdown forms. The parser above only gives the
    // findings it recognises a better message. False alarms (a TypeScript "[key: string]:" in a code
    // sample) are what --acknowledge-hidden is for.
    const lf = body.replace(/\r\n?/g, "\n");
    const looksLikeDef = /\]:/g;
    for (let m = looksLikeDef.exec(lf); m; m = looksLikeDef.exec(lf)) {
      if (out.length >= MAX_FINDINGS) break;
      const line = lineOf(lf, m.index);
      if (flagged.has(line)) continue;
      flagged.add(line);
      out.push({
        path,
        line,
        kind: "markdown_comment",
        detail: "\"]:\" may end a Markdown link or footnote definition, which renderers hide and agents read. Write links inline, or acknowledge it if it's code",
      });
    }
    if (overBudget()) return tooSlow();
    // Fenced blocks GitHub draws instead of showing (diagrams, maps, models, formulas) drop their comments
    // (%% in Mermaid, % in TeX). Agent instructions don't need them, so they're refused outright.
    // Matched anywhere on a line, so a fence opened after a list marker or quote is still seen.
    // A fence starts only at the first backtick or tilde of a run, which keeps this linear.
    const drawnFence = /(?<![`~])(?:`{3,}|~{3,})[ \t]*(mermaid|math|geojson|topojson|stl)\b/gi;
    for (let m = drawnFence.exec(body); m; m = drawnFence.exec(body)) {
      if (out.length >= MAX_FINDINGS) break;
      out.push({ path, line: lineOf(body, m.index), kind: "hidden_html", detail: `a ${m[1]!.toLowerCase()} block, which GitHub draws instead of showing, so comments in it are hidden. Agent instructions don't need one` });
    }
    // Math ($...$, $$...$$, across lines or not) hides % comments. Telling math from prose means parsing it, so
    // instead: if the file has a $ anywhere, every line with a % is flagged. Complete, linear, can't miss.
    if (body.includes("$")) {
      const lines2 = body.split(/\r\n?|\n/);
      for (let i = 0; i < lines2.length && out.length < MAX_FINDINGS; i++) {
        if (lines2[i]!.includes("%")) {
          out.push({ path, line: i + 1, kind: "hidden_html", detail: "a % in a file with $ in it: GitHub renders $ math and hides % comments in it. Reword, or acknowledge it" });
        }
      }
    }
    // Inline link titles show only on hover, like a definition's title.
    const inlineTitle = /\]\([ \t\n]*(?:<[^>\n]*>|[^\s()<]+)[ \t\n]+["'(]/g; // the title's opening is enough
    for (let m = inlineTitle.exec(body); m; m = inlineTitle.exec(body)) {
      if (out.length >= MAX_FINDINGS) break;
      out.push({ path, line: lineOf(body, m.index), kind: "markdown_comment", detail: "link title, shown only on hover: GitHub doesn't render it, agents read it" });
    }
    // Images: inline, reference-style, and HTML.
    const image = /!\[/g; // the opener is enough; HTML images are raw HTML, flagged above
    for (let m = image.exec(body); m; m = image.exec(body)) {
      if (out.length >= MAX_FINDINGS) break;
      out.push({ path, line: lineOf(body, m.index), kind: "image_reference", detail: "image in agent instructions: reviewers rarely open it, agents may read text inside it" });
    }
  }
  if (isMarkdownish(path) && out.length < MAX_FINDINGS) {
    const left = SCAN_BUDGET_MS - (Date.now() - started);
    if (left <= 0) return tooSlow();
    // One finding per line: the pattern checks above usually say more precisely what's wrong.
    const seen = new Set(out.map((f) => f.line));
    for (const f of checkMarkdownSubset(path, body, left).findings) {
      if (out.length >= MAX_FINDINGS) break;
      if (!seen.has(f.line)) out.push(f);
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
