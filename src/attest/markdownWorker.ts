/**
 * The allow-list check for agent context, run in its own process so a hostile
 * file can be stopped by a time limit (see checkMarkdownSubset in context.ts).
 *
 * Reads {"text": "..."} on stdin, parses it as GitHub-flavoured Markdown, and
 * accepts only a subset whose content GitHub shows on the page: headings,
 * paragraphs, lists and task lists, quotes, tables, rules, emphasis,
 * strikethrough, inline code, line breaks, escapes, inline links, and code
 * blocks in a known programming language. Anything else, including any
 * construct this list doesn't know (whatever GitHub adds later), is reported.
 *
 * Writes {"unsupported": [{type, line, detail}], "visible": "..."} on stdout:
 * `visible` is the text this subset displays, for the GitHub renderer check.
 */
import { Lexer, type Token } from "marked";
import { ALLOWED_BLOCK, ALLOWED_COMMENTS, ALLOWED_INLINE, isAllowedCodeLanguage } from "./markdownSubset.js";

interface Finding {
  type: string;
  line: number;
  detail: string;
}

function check(text: string): { unsupported: Finding[]; visible: string } {
  const body = text.replace(/\r\n?/g, "\n");
  const lexer = new Lexer();
  const tokens = lexer.lex(body);
  const unsupported: Finding[] = [];
  const visible: string[] = [];

  // Line numbers: find each token's raw text, walking forward.
  let cursor = 0;
  let line = 1;
  const lineOf = (raw: string) => {
    const probe = raw.trimStart().split("\n")[0]!;
    const at = probe ? body.indexOf(probe, cursor) : -1;
    if (at < 0) return line;
    for (let i = cursor; i < at; i++) if (body.charCodeAt(i) === 10) line++;
    cursor = at;
    return line;
  };

  const report = (t: Token, detail: string) => {
    if (unsupported.length < 50) unsupported.push({ type: t.type, line: lineOf(t.raw ?? ""), detail });
  };

  const walk = (list: Token[] | undefined, inline: boolean) => {
    for (const t of list ?? []) {
      const allowed = inline ? ALLOWED_INLINE.has(t.type) : ALLOWED_BLOCK.has(t.type) || ALLOWED_INLINE.has(t.type);
      // Slipmark's own markers, and nothing else, may appear as HTML (one per line, exact text).
      if (t.type === "html" && (t.raw ?? "").trim().split(/\n+/).every((l) => ALLOWED_COMMENTS.has(l.trim()))) continue;
      if (!allowed) {
        report(t, `${t.type === "html" ? "raw HTML" : t.type === "image" ? "an image" : `"${t.type}"`} isn't in the plain Markdown agent instructions may use`);
        continue;
      }
      const any = t as Token & { text?: string; lang?: string; title?: string | null; tokens?: Token[]; items?: { tokens?: Token[] }[]; header?: { tokens?: Token[] }[]; rows?: { tokens?: Token[] }[][] };
      if (t.type === "code") {
        const lang = (any.lang ?? "").trim().split(/\s+/)[0] ?? "";
        if (!isAllowedCodeLanguage(lang)) {
          report(t, `a code block marked "${lang}", which GitHub may draw instead of showing. Use a plain code block or a programming language`);
          continue;
        }
        visible.push(any.text ?? "");
        continue;
      }
      if (t.type === "link" && any.title) report(t, "a link title, which shows only on hover");
      if (t.type === "codespan" || (t.type === "text" && !any.tokens)) visible.push(any.text ?? "");
      if (t.type === "escape") visible.push(any.text ?? "");
      const childInline = inline || ["paragraph", "heading", "text", "strong", "em", "del", "link"].includes(t.type);
      walk(any.tokens, childInline);
      for (const item of any.items ?? []) walk(item.tokens, false);
      for (const cell of any.header ?? []) walk(cell.tokens, true);
      for (const row of any.rows ?? []) for (const cell of row) walk(cell.tokens, true);
    }
  };
  walk(tokens, false);
  // Link reference definitions never render (they're collected, not tokens).
  for (const label of Object.keys(tokens.links ?? {})) {
    if (unsupported.length >= 50) break;
    unsupported.push({ type: "def", line: lineOf(`[${label}]`), detail: "a link definition, which doesn't render. Write the link inline instead" });
  }
  return { unsupported, visible: visible.join("\n") };
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const { text } = JSON.parse(input) as { text: string };
  process.stdout.write(JSON.stringify(check(text)));
});
