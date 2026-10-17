# Verdict attestation

A verdict is only worth something if you can prove what it was about.
DriftGuard's attestation gate makes every agent verdict carry that proof.

## The model

1. An agent finishes a step that gives a verdict: a security audit, a code
   review, a QA run.
2. It records an **attestation**: who it is, the verdict, and the SHA-256 of
   every file it actually read.
3. Before anything ships, `driftguard verify` re-hashes those files on the tree
   you are about to merge. If a single byte differs, the verdict was about a
   different file, and the gate refuses.

Nothing here calls a model. It's a hash comparison, so it's fast, cheap and
gives the same answer every time.

## The attestation file

```json
{
  "schema": "driftguard/attestation@1",
  "by": "security-audit-agent",
  "verdict": "cleared",
  "at": "2026-10-17T09:00:00.000Z",
  "subjects": [
    { "path": "specs/invoice-export.md", "sha256": "<64 lowercase hex>" }
  ],
  "note": "optional free text"
}
```

- `path` is relative to the repository root, with forward slashes.
- `verdict` of `pass` or `cleared` can clear the gate. Anything else blocks.
- `at` and `note` are informational. The gate never trusts them.

Files live in `.driftguard/attestations/` by default, one JSON file each.
Change it with `--dir`.

## Writing attestations

From a shell step:

```bash
driftguard attest --by review-agent --verdict pass \
  --subject src/export.ts --subject src/export.test.ts \
  --note "Reviewed against SPECS/invoice-export.md"
```

From code:

```ts
import { createAttestation, writeAttestation, defaultAttestationPath } from "driftguard";

const att = createAttestation({
  by: "security-audit-agent",
  verdict: "cleared",
  subjects: ["specs/invoice-export.md"],
});
writeAttestation(defaultAttestationPath(".driftguard/attestations", att), att);
```

Attest the files the agent **read**, at the moment it gave the verdict. If the
agent read a spec and wrote a brief, attest the spec. If a later step rewrites
the spec, the old verdict will (correctly) stop clearing.

## Verifying

```bash
driftguard verify [--dir .driftguard/attestations] [--require <file>...] [--json]
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

`--require` is how you stop the quiet failure where an agent simply never
produces a verdict. List the files that must be covered and the gate refuses
when one isn't.

## Why the gate checks content, not branches

The incident behind this feature: a final verification job checked out the
wrong branch, so it re-tested a tree that had already passed and could never
fail. Branch names, job names and timestamps can all be wrong without anyone
noticing. A content hash can't. Run `verify` on the exact tree you are about to
merge and a verdict produced anywhere else won't match.

## Security notes

- Attestation files are untrusted input. Subject paths that are absolute or
  escape the repository root are rejected and never read.
- The gate proves a verdict is about the current bytes. It doesn't prove the
  verdict is right, or that the attestation was written by the agent named in
  `by`. Protect who can write to the attestation directory as you would any CI
  input.
