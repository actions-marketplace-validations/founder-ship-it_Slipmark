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
 * The text with code blanked out (same length, same line breaks): fenced code
 * blocks, read line by line, and inline code spans. Used only where code
 * should be exempt, so a mis-read here makes the check stricter or looser by a
 * little, never silently off: the allow-list and GitHub's renderer still apply.
 */
function maskCode(text: string): string {
  const lines = text.split("\n");
  let fence: string | null = null;
  const blank = (l: string) => l.replace(/[^\r]/g, " ");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const open = /^ {0,3}(?:>[ \t]?)*(`{3,}|~{3,})/.exec(l);
    if (fence) {
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && /^[ \t>]*[`~]+[ \t]*\r?$/.test(l)) fence = null;
      lines[i] = blank(l);
      continue;
    }
    if (open) {
      fence = open[1]!;
      lines[i] = blank(l);
      continue;
    }
    lines[i] = l.replace(/(`+)[^`]*?\1/g, (m) => " ".repeat(m.length));
  }
  return lines.join("\n");
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
  if (Buffer.byteLength(text, "utf8") > MAX_SCAN) {
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
    // Code (fenced blocks and inline spans) is shown as written, so a TypeScript <T> there is fine. Telling code
    // from prose here uses a simple line-based reading; the allow-list's parser and GitHub's renderer back it up.
    const rawHtml = /<\?|<!(?:[A-Za-z]|\[CDATA\[)|<\/?(?![A-Za-z][A-Za-z0-9+.-]{1,31}:|[^\s<>@]+@[^\s<>@]+>)[A-Za-z]/g;
    const prose = maskCode(body);
    for (let m = rawHtml.exec(prose); m; m = rawHtml.exec(prose)) {
      if (out.length >= MAX_FINDINGS) break;
      out.push({ path, line: lineOf(body, m.index), kind: "hidden_html", detail: "raw HTML: GitHub hides attributes and some tags, agents read them. Write agent instructions in plain Markdown" });
    }
    if (overBudget()) return tooSlow();
    const flagged = new Set<number>();
    // Every link or footnote definition contains the two characters "]:" (the label's closing bracket, then
    // the colon), however the label is split or wherever it sits. So every "]:" is flagged: a complete
    // over-approximation, linear, with no guessing about Markdown forms. False alarms (a TypeScript "[key: string]:" in a code
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
    // Text after a code block's language isn't shown by GitHub. Anything after the language is refused.
    const fenceInfo = /(?<![`~])(?:`{3,}|~{3,})[ \t]*[^\s`~]+[ \t]+\S/g;
    for (let m = fenceInfo.exec(body); m; m = fenceInfo.exec(body)) {
      if (out.length >= MAX_FINDINGS) break;
      out.push({ path, line: lineOf(body, m.index), kind: "hidden_html", detail: "text after a code block's language, which GitHub doesn't show" });
    }
    // Math: GitHub draws $...$, $$...$$ and $`...`$ in the browser, and TeX can draw text as blank space.
    // GitHub's Markdown API returns math as plain text, so the renderer check can't see it: this rule has to be
    // complete on its own. All math needs a $, so every line with a $ is flagged, code included: deciding what is
    // code would mean trusting a guess that a crafted file can fool. Linear, can't miss.
    {
      const proseLines = body.replace(/\r\n?/g, "\n").split("\n");
      for (let i = 0; i < proseLines.length && out.length < MAX_FINDINGS; i++) {
        if (proseLines[i]!.includes("$")) {
          out.push({ path, line: i + 1, kind: "hidden_html", detail: "a $: GitHub may draw it as math, which can show text as blank space. Reword it, or acknowledge it if it's code" });
        }
      }
    }
    // Named entities for invisible characters (&ZeroWidthSpace;, &shy;, &rlm; ...).
    const namedInvisible = /&(?:ZeroWidthSpace|NegativeVeryThinSpace|NegativeThinSpace|NegativeMediumSpace|NegativeThickSpace|zwj|zwnj|shy|lrm|rlm|NoBreak|InvisibleTimes|InvisibleComma|it|ic|af|ApplyFunction|ii|dd|DD|ee|lre|rle|lro|rlo|pdf|nbsp);/g;
    for (let m = namedInvisible.exec(body); m; m = namedInvisible.exec(body)) {
      if (out.length >= MAX_FINDINGS) break;
      if (m[0] === "&nbsp;") continue; // a visible space
      out.push({ path, line: lineOf(body, m.index), kind: "invisible_characters", detail: `an invisible character written as ${m[0]}` });
    }
    // Invisible characters written as HTML entities (&#x200B;, &#8238;) are just as invisible once rendered.
    const entity = /&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));/g;
    for (let m = entity.exec(body); m; m = entity.exec(body)) {
      if (out.length >= MAX_FINDINGS) break;
      const cp = m[1] ? parseInt(m[1], 16) : parseInt(m[2]!, 10);
      if (cp > 0x10ffff) continue;
      INVISIBLE.lastIndex = 0;
      if (INVISIBLE.test(String.fromCodePoint(cp))) {
        out.push({ path, line: lineOf(body, m.index), kind: "invisible_characters", detail: `an invisible character written as ${m[0]}` });
      }
      INVISIBLE.lastIndex = 0;
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
