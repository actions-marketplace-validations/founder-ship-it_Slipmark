/**
 * The referee for agent context: GitHub's own Markdown renderer.
 *
 * This asks GitHub to render the file (POST /markdown in "markdown" mode, the
 * renderer behind file and README views) and checks that every word of the
 * file's own text appears in what GitHub shows. The expected words come from
 * the source, not from a parser, so nothing a parser quietly drops escapes the
 * comparison. Nothing is stripped from the source but a known code-block
 * language word, list numbers and Slipmark's own markers. Link addresses are
 * counted on both sides (written in the source, in href on the page), and
 * each emoji shortcode must have become an emoji, so nothing GitHub shows can
 * stand in for something it hides. If GitHub ever hides something, or changes how it renders, this
 * catches it: the answer comes from GitHub, not from rules written here.
 *
 * Runs in GitHub Actions, where a token is available. Outside Actions it's
 * skipped and the report says so; inside Actions without a token it refuses.
 */
import type { HiddenFinding } from "./context.js";
import { isAllowedCodeLanguage } from "./markdownSubset.js";

export type RenderFn = (text: string) => Promise<string>;

/** GitHub's renderer, with the job's token. Throws on any failure: the caller refuses. */
export function githubRenderer(opts: { token: string; repo?: string; apiUrl?: string; fetchImpl?: typeof fetch }): RenderFn {
  const f = opts.fetchImpl ?? fetch;
  const url = `${(opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "")}/markdown`;
  return async (text: string) => {
    const res = await f(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
        "User-Agent": "slipmark",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ text, mode: "markdown" }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`GitHub's renderer answered ${res.status}`);
    return await res.text();
  };
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026",
  copy: "\u00A9", reg: "\u00AE", trade: "\u2122", rarr: "\u2192", larr: "\u2190", uarr: "\u2191", darr: "\u2193",
  times: "\u00D7", divide: "\u00F7", plusmn: "\u00B1", deg: "\u00B0", middot: "\u00B7", bull: "\u2022",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D", laquo: "\u00AB", raquo: "\u00BB",
  euro: "\u20AC", pound: "\u00A3", yen: "\u00A5", cent: "\u00A2", sect: "\u00A7", para: "\u00B6", check: "\u2713",
};
/** Stands in for one emoji on both sides of the comparison. A private-use character: never a word. */
const EMOJI = "\uE000";

/** The text a reader sees in rendered HTML: no tags, no attributes, no script or style. Emoji shortcodes count by name. */
export function visibleText(html: string): string {
  return decodeEntities(
    html
      // Math, if GitHub ever returns it as an element, is drawn by the browser: its source doesn't count as visible.
      // Today the API returns math as plain text, so math is refused by the pattern checks (any $ outside code).
      .replace(/<(script|style|template|math-renderer|math)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      // A link's address counts as shown (on hover), matching the source, where it's written. Heading anchors
      // GitHub adds aren't in the source, so they don't count: they could otherwise make up for hidden words.
      .replace(/<a\b(?![^>]*\bclass="[^"]*\banchor\b)[^>]*\bhref="([^"]*)"[^>]*>/gi, " $1 ")
      .replace(/<g-emoji\b[^>]*>[\s\S]*?<\/g-emoji>/gi, ` ${EMOJI} `)
      .replace(/<[^>]*>/g, " "),
  ).replace(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu, ` ${EMOJI} `);
}

function words(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

/** HTML character references decoded, as a browser shows them. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * The words a reader should see, taken from the source itself. Left out: a
 * code block's language word (when it's a known language), ordered-list
 * numbers (drawn, not written), and Slipmark's own comment markers. Emoji
 * shortcodes are counted as emoji.
 */
export function expectedText(source: string): string {
  return decodeEntities(
    source
      .replace(/\r\n?/g, "\n")
      .replace(/<!-- slipmark:(?:begin|end) -->/g, " ")
      // An emoji shortcode becomes the emoji itself: counted as one emoji, not as words (see missingWords).
      .replace(/:[a-z0-9_+-]+:/gi, ` ${EMOJI} `)
      // A code block's language isn't shown. Only a single, known language word is left out; anything else
      // on a fence line stays expected, so if GitHub hides it, the file is refused.
      .replace(/^([ \t>]*)(?:`{3,}|~{3,})[ \t]*([^\s`~]*)[ \t]*$/gm, (m, lead: string, lang: string) => (isAllowedCodeLanguage(lang) ? lead : m))
      .replace(/^([ \t>]*)\d{1,9}[.)](?=[ \t]|$)/gm, "$1"),
  );
}

/** Words the source says a reader should see that GitHub's rendering doesn't show (or shows fewer times). */
export function missingWords(expected: string, renderedHtml: string): string[] {
  const shown = visibleText(renderedHtml);
  const want = words(expected);
  const got = words(shown);
  const missing: string[] = [];
  for (const [w, n] of want) if ((got.get(w) ?? 0) < n) missing.push(w);
  // Each shortcode must have become an emoji. One GitHub shows as typed (not a real emoji name) is refused.
  const count = (t: string) => t.split(EMOJI).length - 1;
  if (count(expected) > count(shown)) missing.push("emoji");
  return missing;
}

/** Compare one file with GitHub's rendering. Any failure to ask GitHub refuses: it fails closed. */
export async function compareWithGitHub(path: string, text: string, render: RenderFn): Promise<HiddenFinding[]> {
  const expectedVisible = expectedText(text);
  let html: string;
  try {
    html = await render(text);
  } catch (e) {
    return [{ path, line: 1, kind: "not_plain_markdown", detail: `couldn't confirm with GitHub's renderer (${e instanceof Error ? e.message : String(e)})` }];
  }
  const missing = missingWords(expectedVisible, html);
  if (!missing.length) return [];
  return [
    {
      path,
      line: 1,
      kind: "not_plain_markdown",
      detail: `GitHub's renderer doesn't show all of it: ${missing.slice(0, 8).map((w) => `"${w}"`).join(", ")}${missing.length > 8 ? ` and ${missing.length - 8} more` : ""} are missing from the page`,
    },
  ];
}
