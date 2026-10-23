# Hash modes (draft spec)

> Status: **draft, not implemented.** Target: v0.5, alongside
> [attestation v2](./attestation-v2.md).

Byte hashing breaks on harmless changes: a formatter run, a line-ending flip,
trailing whitespace. Hash modes let a repo choose, per path, how much of that
it tolerates. Strict byte hashing stays the default.

## The one rule

**A false mismatch is acceptable. A false match is not.**

When a mode can't be sure two versions mean the same thing, it treats them as
different. Every edge case below is decided that way. A formatting-tolerant
mode that occasionally refuses is annoying. One that occasionally lets a real
change through would make Slipmark worthless.

## Who chooses the mode

The **policy**, never the attester.

At attest time Slipmark records every digest it can compute for a file, in
`subjects[].digests`. At verify time the matching rule in
`.slipmark/policy.json` says which digest has to match:

```json
{ "paths": ["src/**/*.ts"], "hash": "ast" }
```

So an agent can't pick a loose mode to get through, and you can tighten or
loosen a path later without anyone re-attesting. If the digest the policy asks
for wasn't recorded (an older attestation, or a file the mode can't handle),
`verify` falls back to the byte hash, which is always stricter.

## The modes

| Mode | Digest key | Tolerates | Files |
|---|---|---|---|
| `byte` | `sha256` | Nothing | All |
| `normalised` | `normalised@1` | Line endings, trailing whitespace, BOM, trailing blank lines | Text files |
| `ast` | `ast:ts@1`, `ast:json@1` | Formatting that doesn't change the parsed program | TS, JS, TSX, JSX, JSON |

Strictness order: `byte` > `normalised` > `ast`.

Every non-byte digest is domain-separated: the SHA-256 is over a fixed prefix
(`slipmark/normalised@1\n`, `slipmark/ast:ts@1\n`) followed by the canonical
form. A digest from one mode can never collide with one from another.

### `byte`

The SHA-256 of the file's raw bytes. Exactly what v1 does. Use it for anything
security critical, anything you don't format automatically, and any file type
not listed below.

### `normalised@1`

Canonical form:

1. Strip a leading UTF-8 BOM.
2. Convert CRLF and lone CR to LF.
3. Strip spaces and tabs at the end of every line.
4. Remove blank lines at the end of the file, then end with exactly one LF.

Nothing else changes. Indentation, blank lines inside the file and line
wrapping are all kept, because they carry meaning in Python, YAML, Makefiles
and Markdown.

Not computed for binary files (any NUL byte in the first 8 KB).

Known trade-off: in Markdown, two trailing spaces mean a hard line break.
`normalised` treats adding or removing them as no change. If that matters for
your docs, keep `.md` on `byte`.

### `ast:ts@1`

For `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`.

The file is parsed with the TypeScript compiler's parser (syntax only, no type
checking) and the tree is serialised in a fixed order:

- Each node: its syntax kind, plus any flag that changes meaning (for example
  `OptionalChain`, `let` versus `const`).
- Identifiers: their text.
- String, template and regular expression literals: their value, so `'a'` and
  `"a"` match.
- Numeric literals: their value, so `.5` and `0.5` match, and `1_000` and
  `1000` match. BigInt literals by their value.
- Redundant parentheses are dropped. The tree already encodes grouping, so
  `(a + b) * c` and `a + b * c` still differ.
- Comments: included. Every comment, in order, with each line trimmed. A
  comment can change what an agent reading the file will do, so editing one is
  a real change.

What it ignores, so these all still match after a Prettier run: quote style,
semicolons, trailing commas, indentation, line wrapping, blank lines, redundant
parentheses.

Edge cases, all decided by the one rule:

- **Files that don't parse.** No `ast` digest is recorded at attest time. At
  verify time, a current file that doesn't parse is a mismatch.
- **Directive prologues.** `"use strict"` and `("use strict")` behave
  differently. Parentheses around an expression statement at the start of a
  body are kept.
- **JSX text.** JSX whitespace rules are subtle and formatters re-wrap JSX
  text. v1 of this mode keeps JSX text whitespace as written. Expect some
  false mismatches on JSX-heavy files after a re-wrap. Better than a false
  match.
- **Comment position.** Moving a comment without changing its text doesn't
  change the digest. Accepted: the risk comments carry is in their content.

**Pinned parser.** The canonical form depends on the parser. Slipmark pins an
exact TypeScript version as a dependency and keeps golden tests of the
serialisation. Any TypeScript upgrade that changes a golden test ships as a
new key (`ast:ts@2`), and `verify` keeps the old implementation so existing
attestations still check.

### `ast:json@1`

For `.json`. Parsed, then serialised with the JSON Canonicalization Scheme
(RFC 8785): sorted keys, no whitespace, canonical numbers. Key order and
formatting stop mattering.

A file with duplicate keys gets no `ast:json@1` digest, because parsers
disagree on which value wins.

`.jsonc` and `package.json` with comments are out of scope for v1 and stay on
`byte`.

## Better messages, even in strict mode

Because every digest is recorded at attest time, `verify` can tell a
formatting change from a content change even when the policy requires `byte`:

```text
✗ hash_mismatch   reviewer gave "pass" for a different version of src/export.ts.
                  Formatting only: the ast digest still matches.
                  Policy requires a byte match on src/**.
                  Re-attest the diff: slipmark diff-since src/export.ts
```

versus:

```text
✗ hash_mismatch   reviewer gave "pass" for a different version of src/export.ts.
                  Content changed after the verdict.
```

The gate gives the same answer either way. The difference is that the person
reading it knows whether this is thirty seconds of work or a real re-review.

## CLI

- `slipmark attest` records all applicable digests automatically. No flag.
- `slipmark hash <file> [--mode normalised|ast]` prints a file's digests, for
  debugging.
- `slipmark verify` uses the policy. `--hash byte` forces byte matching for
  one run, whatever the policy says.

## Out of scope for v1

- Python, Go, YAML, Markdown structure. Each needs its own pinned parser and
  its own edge-case review. YAML in particular has too many ways for formatting
  to change meaning.
- Semantic equivalence (renamed variables, reordered imports, refactors).
  That is judging the change, which Slipmark doesn't do. Use a delta
  re-attestation instead.
