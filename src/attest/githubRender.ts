/**
 * The referee for agent context: GitHub's own Markdown renderer.
 *
 * The allow-list (markdownWorker.ts) accepts only plain Markdown and says what
 * text that Markdown displays. This asks GitHub to render the same file
 * (POST /markdown, the renderer behind README and pull request views) and
 * checks every word the allow-list expects to see is in GitHub's output. If
 * GitHub ever hides something the allow-list thinks is visible, or changes how
 * it renders, this catches it: the answer comes from GitHub, not from rules
 * written here.
 *
 * Runs in GitHub Actions, where a token is available. Elsewhere it's skipped and
 * the report says so.
 */
import type { HiddenFinding } from "./context.js";

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
      body: JSON.stringify({ text, mode: "gfm", ...(opts.repo ? { context: opts.repo } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`GitHub's renderer answered ${res.status}`);
    return await res.text();
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The text a reader sees in rendered HTML: no tags, no attributes, no script or style. Emoji shortcodes count by name. */
export function visibleText(html: string): string {
  return html
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<g-emoji\b[^>]*\balias="([^"]*)"[^>]*>[\s\S]*?<\/g-emoji>/gi, " $1 ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const cp = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

function words(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

/** Words the allow-list expects to be visible that GitHub's rendering doesn't show (or shows fewer times). */
export function missingWords(expected: string, renderedHtml: string): string[] {
  const want = words(expected);
  const got = words(visibleText(renderedHtml));
  const missing: string[] = [];
  for (const [w, n] of want) if ((got.get(w) ?? 0) < n) missing.push(w);
  return missing;
}

/** Compare one file with GitHub's rendering. Any failure to ask GitHub refuses: it fails closed. */
export async function compareWithGitHub(path: string, text: string, expectedVisible: string, render: RenderFn): Promise<HiddenFinding[]> {
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
