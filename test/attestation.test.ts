import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import {
  createAttestation,
  writeAttestation,
  defaultAttestationPath,
  verifyAttestations,
  resolveSubject,
  ATTESTATION_SCHEMA,
} from "../src/attest/attestation.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "dg-attest-"));
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(join(root, "specs/feature.md"), "# Feature\nTenant isolation: every query filters by account_id.\n");
  writeFileSync(join(root, "specs/other.md"), "# Other\n");
  return root;
}

const DIR = ".slipmark/attestations";

function attest(root: string, subjects: string[], verdict = "pass", by = "security-audit") {
  const att = createAttestation({ root, subjects, verdict, by, now: new Date("2026-10-17T09:00:00Z") });
  writeAttestation(defaultAttestationPath(join(root, DIR), att), att);
  return att;
}

test("attest: records a SHA-256 per subject, relative path, schema", () => {
  const root = repo();
  const att = attest(root, ["specs/feature.md"]);
  assert.equal(att.schema, ATTESTATION_SCHEMA);
  assert.equal(att.subjects[0]!.path, "specs/feature.md");
  assert.match(att.subjects[0]!.sha256, /^[0-9a-f]{64}$/);
  rmSync(root, { recursive: true, force: true });
});

test("verify: untouched files with a passing verdict clear the gate", () => {
  const root = repo();
  attest(root, ["specs/feature.md", "specs/other.md"]);
  const r = verifyAttestations({ root });
  assert.equal(r.ok, true);
  assert.equal(r.results.filter((x) => x.status === "verified").length, 2);
});

test("verify: a file edited after the verdict is refused (hash_mismatch)", () => {
  const root = repo();
  attest(root, ["specs/feature.md"]);
  // The spec changes after the audit: the old verdict no longer applies.
  writeFileSync(join(root, "specs/feature.md"), "# Feature\nTenant isolation: removed for speed.\n");
  const r = verifyAttestations({ root });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0]!.status, "hash_mismatch");
  assert.notEqual(r.failures[0]!.expected, r.failures[0]!.actual);
});

test("verify: the wrong-branch failure. A verdict from one branch is refused on another", () => {
  const root = repo();
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  // Agent branch: the spec is changed, then audited and cleared there.
  git("checkout", "-qb", "agent/feature");
  writeFileSync(join(root, "specs/feature.md"), "# Feature v2\nTenant isolation: every query filters by account_id.\n");
  attest(root, ["specs/feature.md"], "cleared");
  assert.equal(verifyAttestations({ root }).ok, true);
  // A job that checks out main but reads the agent's verdict must not go green.
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", "specs");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v2");
  git("checkout", "-q", "main");
  const r = verifyAttestations({ root });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0]!.status, "hash_mismatch");
});

test("verify: a failing verdict blocks even when hashes match", () => {
  const root = repo();
  attest(root, ["specs/feature.md"], "fail");
  const r = verifyAttestations({ root });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0]!.status, "verdict_not_passing");
});

test("verify: a deleted subject is refused", () => {
  const root = repo();
  attest(root, ["specs/other.md"]);
  rmSync(join(root, "specs/other.md"));
  const r = verifyAttestations({ root });
  assert.equal(r.failures[0]!.status, "subject_missing");
});

test("verify: --require catches a file nobody attested", () => {
  const root = repo();
  attest(root, ["specs/other.md"]);
  const r = verifyAttestations({ root, require: ["specs/feature.md"] });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0]!.status, "unattested");
  assert.equal(r.failures[0]!.subject, "specs/feature.md");
});

test("verify: no attestations at all is a refusal, not a silent pass", () => {
  const root = repo();
  const r = verifyAttestations({ root });
  assert.equal(r.ok, false);
  assert.equal(r.checked, 0);
});

test("verify: malformed attestation files are refused", () => {
  const root = repo();
  mkdirSync(join(root, DIR), { recursive: true });
  writeFileSync(join(root, DIR, "broken.json"), "{ not json");
  writeFileSync(join(root, DIR, "wrong.json"), JSON.stringify({ verdict: "pass" }));
  const r = verifyAttestations({ root });
  assert.equal(r.ok, false);
  assert.equal(r.failures.length, 2);
  assert.ok(r.failures.every((f) => f.status === "invalid"));
});

test("security: subject paths that escape the repo are never hashed", () => {
  const root = repo();
  assert.equal(resolveSubject(root, "../outside.txt"), null);
  assert.equal(resolveSubject(root, "/etc/passwd"), null);
  assert.throws(() => createAttestation({ root, subjects: ["../x"], verdict: "pass", by: "a" }));
  mkdirSync(join(root, DIR), { recursive: true });
  writeFileSync(
    join(root, DIR, "evil.json"),
    JSON.stringify({ schema: ATTESTATION_SCHEMA, by: "x", verdict: "pass", at: "", subjects: [{ path: "../../etc/passwd", sha256: "a".repeat(64) }] }),
  );
  const r = verifyAttestations({ root });
  assert.equal(r.failures[0]!.status, "invalid");
});

test("security: a symlink inside the repo that points outside it is never hashed", () => {
  const root = repo();
  const outside = mkdtempSync(join(tmpdir(), "sm-outside-"));
  writeFileSync(join(outside, "secret.txt"), "do not read\n");
  symlinkSync(join(outside, "secret.txt"), join(root, "specs/link.md"));
  symlinkSync(outside, join(root, "linkdir"));
  assert.equal(resolveSubject(root, "specs/link.md"), null);
  assert.equal(resolveSubject(root, "linkdir/secret.txt"), null);
  assert.throws(() => createAttestation({ root, subjects: ["specs/link.md"], verdict: "pass", by: "a" }));
  mkdirSync(join(root, DIR), { recursive: true });
  writeFileSync(
    join(root, DIR, "evil.json"),
    JSON.stringify({ schema: ATTESTATION_SCHEMA, by: "x", verdict: "pass", at: "", subjects: [{ path: "specs/link.md", sha256: "a".repeat(64) }] }),
  );
  const r = verifyAttestations({ root });
  assert.equal(r.failures[0]!.status, "invalid");
});

test("security: a symlink that stays inside the repo still works", () => {
  const root = repo();
  symlinkSync(join(root, "specs/feature.md"), join(root, "specs/alias.md"));
  assert.ok(resolveSubject(root, "specs/alias.md"));
});

test("paths: in-repo names that merely start with '..' are accepted", () => {
  const root = repo();
  writeFileSync(join(root, "..notes.md"), "x\n");
  assert.ok(resolveSubject(root, "..notes.md"));
  const att = createAttestation({ root, subjects: ["..notes.md"], verdict: "pass", by: "a" });
  assert.equal(att.subjects[0]!.path, "..notes.md");
});

test("writeAttestation: a link planted at the attestation's name is refused, its target untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "sm-link-"));
  writeFileSync(join(root, "a.ts"), "1\n");
  const outside = join(mkdtempSync(join(tmpdir(), "sm-out-")), "victim.txt");
  writeFileSync(outside, "keep me\n");
  const att = createAttestation({ root, subjects: ["a.ts"], verdict: "pass", by: "rev" });
  const path = defaultAttestationPath(join(root, ".slipmark/attestations"), att);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(outside, path);
  assert.throws(() => writeAttestation(path, att), /is a link/);
  assert.equal(readFileSync(outside, "utf8"), "keep me\n");
});

test("writeAttestation: a linked attestations folder inside the working folder is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "sm-linkdir-"));
  writeFileSync(join(root, "a.ts"), "1\n");
  const outside = mkdtempSync(join(tmpdir(), "sm-outdir-"));
  mkdirSync(join(root, ".slipmark"));
  symlinkSync(outside, join(root, ".slipmark/attestations"));
  const att = createAttestation({ root, subjects: ["a.ts"], verdict: "pass", by: "rev" });
  const prev = process.cwd();
  process.chdir(root);
  try {
    assert.throws(() => writeAttestation(defaultAttestationPath(join(root, ".slipmark/attestations"), att), att), /is a link/);
  } finally {
    process.chdir(prev);
  }
  assert.deepEqual(readdirSync(outside), []);
});

test("writeAttestation: re-attesting replaces the file and leaves no temp files", () => {
  const root = mkdtempSync(join(tmpdir(), "sm-rew-"));
  writeFileSync(join(root, "a.ts"), "1\n");
  const att = createAttestation({ root, subjects: ["a.ts"], verdict: "pass", by: "rev" });
  const path = defaultAttestationPath(join(root, ".slipmark/attestations"), att);
  writeAttestation(path, att);
  writeAttestation(path, { ...att, verdict: "fail" });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).verdict, "fail");
  assert.deepEqual(readdirSync(dirname(path)), [basename(path)]);
});

test("writeAttestation: a linked .slipmark is refused before anything is created at its target", () => {
  const root = mkdtempSync(join(tmpdir(), "sm-linkslip-"));
  writeFileSync(join(root, "a.ts"), "1\n");
  const outside = mkdtempSync(join(tmpdir(), "sm-outslip-"));
  symlinkSync(outside, join(root, ".slipmark"));
  const att = createAttestation({ root, subjects: ["a.ts"], verdict: "pass", by: "rev" });
  const prev = process.cwd();
  process.chdir(root);
  try {
    assert.throws(() => writeAttestation(defaultAttestationPath(join(root, ".slipmark/attestations"), att), att), /\.slipmark is a link/);
  } finally {
    process.chdir(prev);
  }
  assert.deepEqual(readdirSync(outside), [], "no attestations folder made outside the repo");
});

test("writeAttestation: a link deeper in a chosen --dir is refused too", () => {
  const root = mkdtempSync(join(tmpdir(), "sm-deep-"));
  writeFileSync(join(root, "a.ts"), "1\n");
  const outside = mkdtempSync(join(tmpdir(), "sm-outdeep-"));
  mkdirSync(join(root, "x"));
  symlinkSync(outside, join(root, "x/y"));
  const att = createAttestation({ root, subjects: ["a.ts"], verdict: "pass", by: "rev" });
  const prev = process.cwd();
  process.chdir(root);
  try {
    assert.throws(() => writeAttestation(join(root, "x/y/z/w/att.json"), att), /x\/y is a link/);
  } finally {
    process.chdir(prev);
  }
  assert.deepEqual(readdirSync(outside), []);
});

test("writeAttestation: a linked .slipmark is refused when attesting from a subfolder", () => {
  const root = mkdtempSync(join(tmpdir(), "sm-sub-"));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub/b.ts"), "1\n");
  const outside = mkdtempSync(join(tmpdir(), "sm-outsub-"));
  symlinkSync(outside, join(root, ".slipmark"));
  const att = createAttestation({ root, subjects: ["sub/b.ts"], verdict: "pass", by: "rev" });
  const prev = process.cwd();
  process.chdir(join(root, "sub"));
  try {
    assert.throws(() => writeAttestation(join(root, ".slipmark/attestations/x.json"), att), /\.slipmark is a link/);
  } finally {
    process.chdir(prev);
  }
  assert.deepEqual(readdirSync(outside), []);
});
