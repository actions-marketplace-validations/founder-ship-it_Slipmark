# Verdict attestation

A verdict is only worth something if you can prove what it was about.
Slipmark's attestation gate makes every agent verdict carry that proof.

## The model

1. An agent finishes a step that gives a verdict: a security audit, a code
   review, a QA run.
2. It records an **attestation**: who it is, the verdict, and the SHA-256 of
   every file it actually read.
3. Before anything ships, `slipmark verify` re-hashes those files on the tree
   you are about to merge. If a single byte differs, the verdict was about a
   different file, and the gate refuses.

Nothing here calls a model. It's a hash comparison, so it's fast, cheap and
gives the same answer every time.

## The attestation file

```json
{
  "schema": "slipmark/attestation@1",
  "by": "security-audit-agent",
  "verdict": "cleared",
  "at": "2026-10-17T09:00:00.000Z",
  "subjects": [
    { "path": "specs/invoice-export.md", "sha256": "<64 lowercase hex>" }
  ],
  "note": "optional free text"
}
```

- `path` is relative to the folder Slipmark runs from, with forward slashes.
  Run `attest` and `verify` from the repository root (the Action does this by
  default) so paths match.
- `verdict` of `pass` or `cleared` can clear the gate. Anything else blocks.
- `at` and `note` are informational. The gate never trusts them.

Files live in `.slipmark/attestations/` by default, one JSON file each.
Change it with `--dir`.

### Version 2 fields

When you use any of the options below, `attest` writes
`"schema": "slipmark/attestation@2"`. Without them it keeps writing `@1`, so
older verifiers can still read your attestations. `verify` reads both.

```json
{
  "schema": "slipmark/attestation@2",
  "by": "security-audit",
  "verdict": "cleared",
  "at": "2026-10-23T09:00:00.000Z",
  "agent": { "model": "claude-opus-5-5" },
  "subjects": [{ "path": "src/auth/session.ts", "sha256": "<64 lowercase hex>" }],
  "against": [{ "path": "specs/auth.md", "sha256": "<64 lowercase hex>" }],
  "checks": [
    { "command": "npm test", "exitCode": 0, "outputSha256": "<64 lowercase hex>", "durationMs": 4123, "witnessed": true },
    { "command": "npm run lint", "exitCode": 0, "witnessed": false }
  ]
}
```

- `against`: files the verdict was checked **against**, such as a spec or a
  review checklist. Gated like subjects: if one changes, the verdict stops
  counting.
- `checks` with `witnessed: true`: Slipmark ran the command itself
  (`--run`) and recorded the exit code and a hash of the output.
- `checks` with `witnessed: false`: the agent says it ran it (`--check`).
  Recorded and reported as a claim, never trusted to clear the gate. A claim
  that a check *failed* still blocks, because it can only make the gate
  stricter.
- `agent.model`, `agent.harness`, `kind`: claimed. Used only to match a
  policy.

Every field is either **witnessed** (Slipmark computed it) or **claimed** (the
attester said it). The gate only trusts witnessed fields. On a laptop,
"witnessed" means that laptop computed it.

## Writing attestations

From a shell step:

```bash
slipmark attest --by review-agent --verdict pass \
  --subject src/export.ts --subject src/export.test.ts \
  --note "Reviewed against SPECS/invoice-export.md"
```

From code:

```ts
import { createAttestation, writeAttestation, defaultAttestationPath } from "slipmark";

const att = createAttestation({
  by: "security-audit-agent",
  verdict: "cleared",
  subjects: ["specs/invoice-export.md"],
});
writeAttestation(defaultAttestationPath(".slipmark/attestations", att), att);
```

With version 2 fields:

```bash
slipmark attest --by security-audit --verdict cleared \
  --subject src/auth/session.ts \
  --against specs/auth.md \
  --run "npm test -- src/auth" \
  --check "npm run lint=0" \
  --model claude-opus-5-5
```

`--run` executes each command from the repository root before anything is
written. If any `--run` or `--check` exited non-zero, `attest` refuses to
record a passing verdict (exit 2) and writes nothing. Record `--verdict fail`
instead. `--model` falls back to the `SLIPMARK_MODEL` environment variable.

Attest the files the agent **read**, at the moment it gave the verdict. If the
agent read a spec and wrote a brief, attest the spec. If a later step rewrites
the spec, the old verdict will (correctly) stop clearing.

## Verifying

```bash
slipmark verify [--dir .slipmark/attestations] [--require <file>...] [--json]
                [--coverage diff --base <ref> [--ignore <glob>...]]
                [--require-signed --trusted-signer <identity>...] [--no-policy]
```

Exit code 0 means every attested file matches and every verdict passes. Exit
code 1 means the gate refused.

| Status | Meaning |
|---|---|
| `verified` | Passing verdict, file unchanged since the verdict |
| `hash_mismatch` | File changed after the verdict |
| `subject_missing` | Attested file no longer exists |
| `verdict_not_passing` | The agent's own verdict was not a pass |
| `unattested` | A `--require`d file has no passing, current verdict, or the directory is empty |
| `invalid` | Malformed JSON, wrong schema, or a path outside the repository |
| `against_changed` | A file the verdict was checked against changed or was deleted |
| `check_failed` | A check recorded a non-zero exit code (witnessed or claimed) |
| `model_not_allowed` | The policy lists allowed models and this verdict's model isn't one, or it has none |
| `uncovered` | Coverage is on and a changed file has no current, passing verdict |
| `signature_invalid` | The verdict is signed, but the signature doesn't verify or the attestation was edited after signing |
| `unsigned` | Signatures are required and this verdict isn't signed |
| `signer_not_trusted` | Signatures are required and this verdict was signed by an identity the policy doesn't trust |
| `context_changed` | An agent context file (AGENTS.md, a skill, an MCP config) changed after this agent's verdict, or the verdict recorded no context. See [Agent context](#agent-context) |
| `context_unapproved` | A context file changed since the base and no approver (a human, by default) gave it a passing verdict, or a context path is a link to something that isn't context |
| `hidden_content` | A changed context file has text a reviewer may not see: invisible characters, HTML comments, blank padding or images |

A version 1 attestation is judged on version 1 fields only. Anything else in
it is ignored.

When an attestation fails on `against_changed`, `check_failed`,
`model_not_allowed`, `context_changed` or any signature status, none of its subjects count. So `--require` and coverage
report them as not covered too.

Exit code 2 means the command couldn't run. For `verify`: a malformed policy,
a coverage base that isn't in the checkout or isn't a plain ref, coverage run
from somewhere other than the repository root, signatures required but
Sigstore unreachable, a `--policy-from` ref that isn't in the checkout, a
policy on the base that isn't a regular file in a real folder, a subfolder run
when only the repository root has a policy, or a flag given with no value.
For `attest`: a passing verdict refused because a check failed, a missing or
unreadable subject, or bad input.

`--require` is how you stop the quiet failure where an agent simply never
produces a verdict. List the files that must be covered and the gate refuses
when one isn't.

## Coverage: every changed file needs a verdict

```bash
slipmark verify --coverage diff --base origin/main --ignore "docs/**"
```

`verify` works out which files changed since the merge base with `--base`
(committed, staged, unstaged and untracked), and refuses any that no current,
passing verdict covers. It computes the list itself and never reads it from an
attestation. Coverage only runs from the repository root: from a subfolder it
exits 2, because git would only report changes in that folder. Deleted files, submodules and `.slipmark/**` are left out. A
changed file that can't be hashed, such as a link pointing outside the
repository or to nothing, is refused as `invalid`, never skipped. A link to
a folder is refused too, since a link is never treated as a submodule. The
base must be the branch you merge into, such as `origin/main`. Anything
starting with `-` is rejected, and so is `HEAD`, which would compare the
branch with itself and cover nothing. Other names for the same commit (the
current branch's own name, `HEAD~0`) are accepted, because on a push to `main`
the base legitimately equals HEAD and nothing counts as changed. That is why
coverage belongs on pull requests, where the base is the branch you merge
into.

This closes the gap where an agent reviews 3 of 7 changed files and the other
4 go through unreviewed.

In GitHub Actions the base must be in the checkout, so use
`actions/checkout` with `fetch-depth: 0`, then:

```yaml
- uses: founder-ship-it/Slipmark@main
  with:
    coverage-base: origin/main
    coverage-ignore: |
      docs/**
```

## Policy file

Put the same settings in `.slipmark/policy.json` and every `verify` run
(including the Action) picks them up:

```json
{
  "schema": "slipmark/policy@1",
  "coverage": { "mode": "diff", "base": "origin/main", "ignore": ["docs/**", "**/*.lock"] },
  "models": { "allow": ["claude-opus-5-5", "claude-sonnet-5-5"] },
  "signatures": {
    "require": true,
    "trusted": ["https://github.com/acme/api/.github/workflows/agent-review.yml@refs/heads/main"]
  }
}
```

- `coverage`: as above. `--coverage` on the command line overrides it.
- `models.allow`: only verdicts from these models count. Remove an old model
  from the list and its verdicts stop counting: that is how you force a
  re-review when you change models. The model is a claimed field, so this
  catches mistakes, not an attester that lies about its model.
- `signatures`: see [Signed verdicts](#signed-verdicts).
- `require`: files that must have a current, passing verdict, added to any
  `--require`. Prefer this to the Action's `require` input: the policy file is
  read from the base branch, the workflow file isn't (see below).

`--no-policy` ignores the file for one run. If `verify` runs from a subfolder
while the repository root has a policy file, it exits 2 rather than silently
skipping the root's rules. Globs support `**`, `*` and `?` and match the whole
path from the repository root.

### The policy is read from the base branch

A pull request can edit `.slipmark/policy.json`. If the gate read the policy
from the pull request's own checkout, the PR could loosen the rules it is
judged by: drop a path from `require`, remove a model restriction, switch
coverage off. So when a base is known, the policy is read from there:

1. `--policy-from <ref>` (or the Action's `policy-from` input), if given.
   The ref must be in the checkout, or `verify` exits 2.
2. Otherwise the base given with `--coverage diff --base <ref>` on the
   command line, then the pull request's base branch
   (`refs/remotes/origin/$GITHUB_BASE_REF` in GitHub Actions, which must exist
   under exactly that name, so a tag can't stand in for it). The Action fetches the base branch for you
   when the checkout doesn't have it. `coverage.base` inside the policy file is
   not used to find the policy.
3. Otherwise (a local run, a push build) the checkout's own policy, as in v0.4.
   If a base was expected but isn't in the checkout, the report says so and the
   checkout's policy is used.

Run from a subfolder (a package in a monorepo), `verify` reads that folder's
`.slipmark/policy.json` from the base, just as it reads it from disk. If the
folder has none but the repository root does, it exits 2 rather than skip the
root's rules. A policy file on the base that isn't a regular file, or sits in a folder that
isn't a real folder (a linked `.slipmark`, for example), is an error, never
treated as "no policy".

A branch that changes, adds or deletes the policy gets a notice: the base
policy is applied, and the change takes effect once it's merged. Every report
records which policy decided it: `policy.source` (`base`, `working-tree` or
`none`), `policy.ref`, and `policy.sha256`, the hash of the exact file applied.
`--policy-from working-tree` restores the old behaviour.

What this doesn't cover: the workflow file itself. GitHub runs a pull request's
workflow from the pull request, so a PR can change the Action's inputs
(`require`, `fail-on-refusal`, `policy-from`). Keep required paths in the
policy file, and protect `.github/workflows/` and `.slipmark/` with CODEOWNERS
and branch protection. Thanks to Kent Bodrov for reporting this.

## Agent context

A verdict depends on the files the agent read, and on what the agent was told.
AGENTS.md, CLAUDE.md, Cursor rules, skills, hooks and MCP server configs all
steer a coding agent. The 2026 attacks on coding agents changed exactly these
and left the reviewed code alone: instruction files pointing at images with
hidden text, MCP tool definitions that turned malicious after a few calls,
skills hiding text in HTML comments or invisible characters.

Add a `context` section to the policy to bind verdicts to their context too:

```json
{
  "schema": "slipmark/policy@1",
  "context": {}
}
```

That's enough to start. With it:

1. **Verdicts record their context.** `slipmark attest` hashes every agent
   context file in the repo and stores the list in the attestation's `context`
   field (attestation v2). It does this for every verdict whose `kind` isn't
   `human`. `--context` records it without a policy; `--no-context` skips it.
2. **A verdict stops counting when its context changes.** If any context file
   is edited, added or removed after a verdict, the gate refuses it as
   `context_changed`: the agent was working under different instructions, and
   none of its subjects count. A verdict that recorded no context is refused the
   same way, unless `requireRecorded` is `false`. This applies to `agent` and
   `tool` verdicts alike.
3. **A change to the context needs approval.** A context file that changed
   since the base branch needs a current, passing verdict from an approver, or
   the gate refuses it as `context_unapproved`. By default an approver is a
   verdict with `kind: human`:
   ```bash
   slipmark attest --kind human --by paul --verdict pass --subject AGENTS.md
   ```
4. **Hidden text in changed context is refused.** A changed context file is
   scanned, the whole file, for text a reviewer on GitHub may not see:
   invisible, direction-changing or text-smuggling Unicode (zero-width
   characters, bidirectional controls, tags, variation selectors, fillers);
   HTML comments, including one never closed; other raw HTML GitHub doesn't
   show (`<script>`, `<style>`, `<?...?>`, CDATA); Markdown link definitions
   (`[label]: url`) and footnote definitions (`[^note]: text`), found with a
   Markdown parser wherever they sit (in a quote or a list, with an escaped
   label, with the title on the next line), plus a deliberately broad check for
   anything that looks like one, because parsers disagree at the edges (tabs,
   a quote continued without `>`, a label split across lines). The broad check
   also fires inside code blocks, for example on a TypeScript
   `[key: string]: unknown;` line; acknowledge it (below) if so. Every one is flagged, used or not: a definition never renders, so text can
   hide in its label, address or title. Write links inline (`[text](url)`)
   instead. Also flagged: a link title, which shows only on hover; runs of 20
   or more lines that render empty (blank, `&nbsp;`, `<br>`, a lone `\`);
   images, inline or reference-style; and a file that isn't valid UTF-8, or is
   over 512 KB, which can't be checked. Comments, HTML, links and images are
   only looked for in prose files (Markdown, MDX, text, no extension), because
   GitHub shows JSON and YAML as raw text. Any finding is
   refused as `hidden_content`, even with an approval, because the approver may
   not have seen it, unless the approver says they have:
   ```bash
   slipmark attest --kind human --by paul --verdict pass --acknowledge-hidden --subject AGENTS.md
   ```
   An acknowledgement covers those exact bytes only, and the report still
   lists what was acknowledged. The comments `slipmark init` writes
   (`<!-- slipmark:begin -->`, `<!-- slipmark:end -->`) are never flagged. Unchanged files aren't scanned, but once a file is
   touched, an old comment in it counts too.
5. **Links and submodules are refused.** A context path that is a link is
   refused as `context_unapproved`, on every run, unless it points at another
   context file in the repo (`CLAUDE.md -> AGENTS.md` is fine; its content is
   watched through the target). A link to anything else, a linked folder such
   as `.claude -> tools/cfg`, or a git submodule at a context path would put
   instructions where the gate doesn't look.

### Who can approve

`kind` is a claim. An agent can write `--kind human` on its own verdict, so
on its own, check 3 stops mistakes and casual changes, not an agent that
lies. To make approval mean something:

- **Require a person on GitHub.** Add the context paths to CODEOWNERS and
  require code owner review in branch protection. GitHub then enforces a human
  review of any change to them, whatever Slipmark is told.
- **Require a signed approval.** Set `approverSigners` to the identities whose
  [signed verdicts](#signed-verdicts) may approve, for example a workflow that
  only runs after a code owner approves. An approval then counts only if its
  signature is valid and its signer matches. `*` matches anything.

### Where the checks run

The base branch is the approved context: what's merged has been through this
gate. Since the policy itself is [read from the base](#the-policy-is-read-from-the-base-branch),
a pull request can't switch these checks off. Checks 3 and 4 compare against
the base, so use `actions/checkout` with `fetch-depth: 0`. In a pull request
whose base isn't in the checkout, `verify` exits 2 rather than skip them, as
long as the policy it could read has a `context` section. If the base can't be
fetched, the policy comes from the pull request itself (see
[above](#the-policy-is-read-from-the-base-branch)), which could drop the
section; the Action fetches the base to avoid that, and warns if it can't.
With no base expected at all (a local run), they are skipped and the report
says so.

Context checks run from the repository root. An agent working in a subfolder
still reads the root's AGENTS.md, so the check covers the whole repository;
from a subfolder, `attest` and `verify` exit 2.

| Field | Default | Meaning |
|---|---|---|
| `files` | the list below | Globs for agent context files. Case is ignored at the repository root and inside dot-folders, where agents on macOS and Windows open `claude.md` as `CLAUDE.md`, and respected elsewhere, so `docs/providers/claude.md` isn't context. The cost: a nested `pkg/Claude.md` isn't context either |
| `approvers` | `["human"]` | Kinds whose verdict approves a context change: `human`, `tool`, `agent` |
| `approverSigners` | none | If set, an approval must also be signed by one of these identities |
| `requireRecorded` | `true` | Verdicts must record their context |
| `hiddenContent` | `"refuse"` | `"allow"` turns off the hidden-text scan |

Default context files: `AGENTS.md`, `AGENTS.override.md`, `AGENT.md`,
`CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md` and `.claude/` at any depth;
`.mcp.json` at any depth; `CONVENTIONS.md`, `.vscode/mcp.json`,
`.vscode/settings.json`, `.cursorrules`, `.cursor/`,
`.github/copilot-instructions.md`, `.github/instructions/`,
`.github/prompts/`, `.github/agents/`, `.github/chatmodes/`, `.agents/`,
`.gemini/`, `.codex/`, `.windsurfrules`, `.windsurf/`, `.clinerules`,
`.roo/`, `.amazonq/rules/` and `.junie/`. `.slipmark/` is never context.

### What this doesn't cover yet

- **Files the instructions point to.** An image or document referenced from
  AGENTS.md, or a file imported with `@docs/review.md`, isn't context unless
  it matches `files`. Changing it doesn't trip checks 2 to 4. Add such paths
  to `files`, or keep instructions self-contained.
- **What an MCP server does at run time.** Its config and pinned version are
  hashed, not the tool definitions it returns (`tools/list`) or the source of
  a local server.
- **The prompt in a workflow file.** A prompt passed to an agent from
  `.github/workflows/` isn't context; protect workflows with CODEOWNERS.
- **Deletions.** Deleting a context file is caught by check 2, so verdicts
  must be redone, but it needs no approval under check 3.
- **Instructions inside other submodules.** A submodule at a context path is
  refused, but one elsewhere can carry its own AGENTS.md or `.claude/`, which
  agents load when they work in that folder. Updating it trips no context check.
- **Text in a link's address.** An inline link's URL shows only on hover. A
  long or empty-text link (`[](https://...)`) can carry text a reviewer won't
  read.
- **Acknowledgements are as strong as approvals.** `--acknowledge-hidden` is
  recorded on a verdict, so, like `kind`, it's a claim unless you require
  signed approvals with `approverSigners`.

## Signed verdicts

An unsigned attestation proves the files haven't changed since the verdict. It
doesn't prove who gave it: anyone who can push to the repository can write
`"by": "security-reviewer"`. A signed one does.

```bash
slipmark attest --by security-reviewer --verdict pass --subject src/auth/session.ts --sign
```

`--sign` signs the attestation with the identity of the job it runs in, using
[Sigstore](https://www.sigstore.dev) keyless signing. In GitHub Actions that is
the workflow itself (it needs `permissions: id-token: write`), for example
`https://github.com/acme/api/.github/workflows/agent-review.yml@refs/heads/main`.
There are no keys to manage or leak. The signature covers the whole
attestation (verdict, agent, every hash, checks and note) as canonical JSON, and
is recorded in Sigstore's public Rekor transparency log. The Sigstore bundle is
stored in the attestation's `signature` field. Elsewhere, set
`SIGSTORE_ID_TOKEN` to an OIDC token Sigstore accepts.

`verify` checks every signature it finds: the certificate chains to Sigstore,
was issued to a GitHub Actions identity, is in the transparency log, and covers
exactly the attestation as it is now. A signature that fails any of these
refuses as `signature_invalid`, whether or not signatures are required, because
it means the attestation was changed after it was signed.

To make signatures count, require them and list who you trust:

```bash
slipmark verify --require-signed \
  --trusted-signer "https://github.com/acme/api/.github/workflows/agent-review.yml@refs/heads/main"
```

or `signatures.require` and `signatures.trusted` in the policy file, or the
Action's `require-signed` and `trusted-signers` inputs. Then a verdict typed by
hand, or made by any other workflow, doesn't count. `*` in a trusted identity
matches anything. `signatures.issuer` sets the OIDC issuer the signing
certificate must come from (an https URL); it defaults to GitHub Actions. Each
verified result names its signer, and Slipmark Cloud shows it on the proof
record.

**Trust a workflow at a protected ref.** On a pull request, GitHub runs the
workflow file from the pull request itself, so the identity ends in
`@refs/pull/<n>/merge` and the author of the pull request controls it. Trust
the workflow on your default branch (`@refs/heads/main`), run by an event that
uses that version, such as `push`, `workflow_dispatch` or `pull_request_target`,
or a reusable workflow pinned to a protected ref. Protect that branch so
changing the signing workflow needs review.

Signing needs network access to Sigstore. When signatures are required and
Sigstore can't be reached, `verify` exits 2 rather than passing.

Signing uses Sigstore's public service, so the signing certificate, which names
the repository and workflow, is published in Rekor. Don't sign in a private
repository whose name is itself confidential.

## Why the gate checks content, not branches

The incident behind this feature: a final verification job checked out the
wrong branch, so it re-tested a tree that had already passed and could never
fail. Branch names, job names and timestamps can all be wrong without anyone
noticing. A content hash can't. Run `verify` on the exact tree you are about to
merge and a verdict produced anywhere else won't match.

## Security notes

- Attestation files are untrusted input. Subject paths that are absolute,
  escape the repository root, or resolve outside it through a symlink are
  rejected and never read.
- The gate proves a verdict is about the current bytes. It doesn't prove the
  verdict is right. Unsigned, it doesn't prove who wrote it either: protect who
  can write to the attestation directory as you would any CI input, or require
  [signed verdicts](#signed-verdicts) from a workflow you trust.
