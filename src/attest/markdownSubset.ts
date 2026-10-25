/**
 * The plain Markdown agent instructions may use. An allow-list, not a block
 * list: a construct that isn't named here is refused, including any that
 * GitHub adds after this was written. Token names are marked's.
 */

/** Blocks whose content GitHub shows as written. */
export const ALLOWED_BLOCK = new Set(["space", "paragraph", "heading", "list", "list_item", "blockquote", "table", "hr", "code", "text", "checkbox"]);

/** Inline content GitHub shows as written. A link shows its text; its address is on hover (documented). */
export const ALLOWED_INLINE = new Set(["text", "strong", "em", "del", "codespan", "br", "escape", "link", "checkbox"]);

/**
 * Code block languages GitHub highlights and shows as text. Anything else, a
 * diagram or formula language GitHub draws instead of showing (mermaid, math,
 * geojson, ...) or one added later, is refused. No language is fine.
 */
const CODE_LANGUAGES = new Set(
  (
    "bash sh shell zsh fish console shellsession text txt plaintext plain output log diff patch " +
    "json jsonc json5 yaml yml toml ini properties env dotenv csv tsv xml " +
    "javascript js mjs cjs jsx typescript ts tsx mts cts node " +
    "python py python3 ruby rb go golang rust rs java kotlin kt swift objc objective-c " +
    "c h cpp c++ cc hpp cxx csharp cs c# fsharp fs php perl pl lua r dart scala " +
    "elixir ex exs erlang erl haskell hs ocaml ml clojure clj elm nim zig crystal julia " +
    "sql psql pgsql mysql sqlite graphql gql proto protobuf prisma " +
    "html htm css scss sass less vue svelte astro " +
    "dockerfile docker makefile make cmake gradle groovy hcl terraform tf nix " +
    "powershell ps1 pwsh bat cmd batch vim viml nginx apache " +
    "markdown md mdx regex gitignore gitattributes editorconfig http " +
    "conf config cfg jsonl ndjson erb jinja jinja2 j2 handlebars hbs liquid twig ejs mustache"
  ).split(/\s+/),
);

export function isAllowedCodeLanguage(lang: string): boolean {
  return lang === "" || CODE_LANGUAGES.has(lang.toLowerCase());
}

/** Comments Slipmark itself writes (`slipmark init` fences its block in AGENTS.md with these). Exact text only. */
export const ALLOWED_COMMENTS = new Set(["<!-- slipmark:begin -->", "<!-- slipmark:end -->"]);
