# Coding agents

Slipmark only works if agents record their verdicts. `npx slipmark init` writes
the instructions for you. This page explains where they go for each agent and
how to check they are being followed.

## What the agent is told

The block `init` writes (between `<!-- slipmark:begin -->` and
`<!-- slipmark:end -->`) tells the agent to:

1. Run `npx slipmark attest` whenever it gives a verdict: a review passed, an
   audit cleared, tests pass, a spec approved.
2. List every file the verdict is based on, not only the files it changed.
3. Use `--verdict fail` or `--verdict blocked` when something does not pass,
   and never attest `pass` for a file it did not read.
4. Commit the attestation with the change, never edit one by hand, and attest
   again after re-reading a file that changed.
5. Run `npx slipmark verify` before handing over.

Re-running `init` replaces the block in place. Nothing outside the markers is
touched.

## Where each agent reads it

| Agent | File `init` writes | Notes |
|---|---|---|
| OpenAI Codex | `AGENTS.md` | Always written. |
| Cursor | `AGENTS.md`, plus `.cursor/rules/slipmark.mdc` if `.cursor/` exists | The rule is `alwaysApply: true`. |
| GitHub Copilot coding agent | `AGENTS.md`, plus `.github/copilot-instructions.md` if it exists | |
| Claude Code | `CLAUDE.md` if it exists | If the repo has `.claude/` but no `CLAUDE.md`, `init` creates one containing `@AGENTS.md`. Otherwise create that file yourself. |
| Anything else | `AGENTS.md` | Or paste the block into the agent's system prompt. |

## Let the agent run the command

Agents that ask before running shell commands need permission for
`npx slipmark`. In Claude Code, add it to `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(npx slipmark:*)"]
  }
}
```

## Pipelines and scripted agents

If your agents run as scripts (a nightly pipeline, a CI job), call the CLI or
the library directly at the end of each step that gives a verdict:

```bash
npx slipmark attest --by security-audit-agent --verdict cleared \
  --subject specs/invoice-export.md --subject src/export.ts \
  --note "OWASP top 10 pass on the export path"
```

```ts
import { createAttestation, writeAttestation, defaultAttestationPath } from "slipmark";

const att = createAttestation({
  by: "security-audit-agent",
  verdict: "cleared",
  subjects: filesTheAgentRead, // the exact files in the model's context
});
writeAttestation(defaultAttestationPath(".slipmark/attestations", att), att);
```

Attest the files that were actually in the agent's context, collected by your
pipeline code rather than reported by the model. That is the strongest version
of the guarantee: the model can't claim to have read something it was never
given.

## Checking it works

Give the agent an ordinary task with no mention of Slipmark, for example
"Review src/export.ts against specs/invoice-export.md". Afterwards:

```bash
ls .slipmark/attestations/
npx slipmark verify
```

You should see one attestation naming every file the review relied on. Edit
one of those files and run `verify` again: it should refuse.

## Turning on enforcement

`init` starts the workflow in report-only mode. Once attestations are showing
up on pull requests, change this line in `.github/workflows/slipmark.yml`:

```yaml
fail-on-refusal: "true"
```

To insist that particular files always carry a current, passing verdict, list
them under `require:` in the same file.
