import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  createAttestation,
  writeAttestation,
  defaultAttestationPath,
  verifyAttestations,
  loadPolicy,
  globToRegExp,
  changedFiles,
  ATTESTATION_SCHEMA,
  ATTESTATION_SCHEMA_V2,
  POLICY_SCHEMA,
  type Attestation,
  type AttestedCheck,
  type Policy,
} from "../src/attest/attestation.js";

const DIR = ".slipmark/attestations";
const NOW = new Date("2026-10-23T09:00:00Z");

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "sm-v2-"));
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "specs/export.md"), "# Export\nCSV, tenant filtered.\n");
  writeFileSync(join(root, "src/export.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "src/other.ts"), "export const y = 2;\n");
  return root;
}

function save(root: string, att: Attestation): void {
  writeAttestation(defaultAttestationPath(join(root, DIR), att), att);
}

const fakeRun = (exitCode: number) => (_root: string, command: string): AttestedCheck => ({
  command,
  exitCode,
  outputSha256: "a".repeat(64),
  durationMs: 1,
  witnessed: true,
});

function gitRepo(): string {
  const root = repo();
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feature");
  return root;
}

test("attest: without v2 options it still writes @1, so older verifiers can read it", () => {
  const root = repo();
  const att = createAttestation({ root, by: "reviewer", verdict: "pass", subjects: ["src/export.ts"], now: NOW });
  assert.equal(att.schema, ATTESTATION_SCHEMA);
  assert.equal(att.against, undefined);
  assert.equal(att.checks, undefined);
  rmSync(root, { recursive: true, force: true });
});

test("attest: --against, --model and --kind write @2 with the extra fields", () => {
  const root = repo();
  const att = createAttestation({
    root,
    by: "reviewer",
    verdict: "pass",
    subjects: ["src/export.ts"],
    against: ["specs/export.md"],
    agent: { model: "claude-opus-5-5" },
    kind: "agent",
    now: NOW,
  });
  assert.equal(att.schema, ATTESTATION_SCHEMA_V2);
  assert.equal(att.against![0]!.path, "specs/export.md");
  assert.match(att.against![0]!.sha256, /^[0-9a-f]{64}$/);
  assert.equal(att.agent!.model, "claude-opus-5-5");
  rmSync(root, { recursive: true, force: true });
});

test("verify: a v2 attestation with nothing changed clears the gate", () => {
  const root = repo();
  save(root, createAttestation({ root, by: "reviewer", verdict: "pass", subjects: ["src/export.ts"], against: ["specs/export.md"], now: NOW }));
  const r = verifyAttestations({ root, require: ["src/export.ts"] });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  rmSync(root, { recursive: true, force: true });
});

test("verify: the spec changing after the verdict is refused (against_changed), and the subject stops counting", () => {
  const root = repo();
  save(root, createAttestation({ root, by: "reviewer", verdict: "pass", subjects: ["src/export.ts"], against: ["specs/export.md"], now: NOW }));
  writeFileSync(join(root, "specs/export.md"), "# Export\nJSON now.\n");
  const r = verifyAttestations({ root, require: ["src/export.ts"] });
  assert.equal(r.ok, false);
  const statuses = r.failures.map((f) => f.status).sort();
  assert.deepEqual(statuses, ["against_changed", "unattested"]);
  assert.equal(r.results.some((x) => x.status === "verified"), false);
  rmSync(root, { recursive: true, force: true });
});

test("verify: an against file that was deleted is refused", () => {
  const root = repo();
  save(root, createAttestation({ root, by: "reviewer", verdict: "pass", subjects: ["src/export.ts"], against: ["specs/export.md"], now: NOW }));
  rmSync(join(root, "specs/export.md"));
  const r = verifyAttestations({ root });
  assert.equal(r.failures[0]!.status, "against_changed");
  rmSync(root, { recursive: true, force: true });
});

test("attest: --run records a witnessed check", () => {
  const root = repo();
  const att = createAttestation({ root, by: "qa", verdict: "pass", subjects: ["src/export.ts"], run: ["node -e \"console.log('ok')\""], now: NOW });
  assert.equal(att.schema, ATTESTATION_SCHEMA_V2);
  const c = att.checks![0]!;
  assert.equal(c.witnessed, true);
  assert.equal(c.exitCode, 0);
  assert.match(c.outputSha256!, /^[0-9a-f]{64}$/);
  rmSync(root, { recursive: true, force: true });
});

test("attest: a real failing --run refuses a passing verdict and writes nothing", () => {
  const root = repo();
  assert.throws(
    () => createAttestation({ root, by: "qa", verdict: "pass", subjects: ["src/export.ts"], run: ["node -e \"process.exit(3)\""] }),
    /refusing to record "pass".*exited 3/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("attest: a failing --run is fine with a fail verdict", () => {
  const root = repo();
  const att = createAttestation({ root, by: "qa", verdict: "fail", subjects: ["src/export.ts"], run: ["x"], runner: fakeRun(1) });
  assert.equal(att.checks![0]!.exitCode, 1);
  rmSync(root, { recursive: true, force: true });
});

test("attest: a claimed check that failed also refuses a passing verdict", () => {
  const root = repo();
  assert.throws(
    () => createAttestation({ root, by: "qa", verdict: "cleared", subjects: ["src/export.ts"], checks: [{ command: "npm test", exitCode: 1 }] }),
    /refusing to record "cleared"/,
  );
  const ok = createAttestation({ root, by: "qa", verdict: "pass", subjects: ["src/export.ts"], checks: [{ command: "npm test", exitCode: 0 }] });
  assert.equal(ok.checks![0]!.witnessed, false);
  rmSync(root, { recursive: true, force: true });
});

test("verify: a hand-edited pass over a failed witnessed check is refused (check_failed)", () => {
  const root = repo();
  const att = createAttestation({ root, by: "qa", verdict: "fail", subjects: ["src/export.ts"], run: ["npm test"], runner: fakeRun(2) });
  save(root, { ...att, verdict: "pass" });
  const r = verifyAttestations({ root });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0]!.status, "check_failed");
  rmSync(root, { recursive: true, force: true });
});

test("verify: models.allow refuses verdicts from other models, or with no model", () => {
  const root = repo();
  save(root, createAttestation({ root, by: "old", verdict: "pass", subjects: ["src/export.ts"], agent: { model: "old-model" }, now: NOW }));
  save(root, createAttestation({ root, by: "plain", verdict: "pass", subjects: ["src/other.ts"], now: NOW }));
  save(root, createAttestation({ root, by: "new", verdict: "pass", subjects: ["specs/export.md"], agent: { model: "claude-opus-5-5" }, now: NOW }));
  const r = verifyAttestations({ root, policy: { schema: POLICY_SCHEMA, models: { allow: ["claude-opus-5-5"] } } });
  const byStatus = (s: string) => r.results.filter((x) => x.status === s).map((x) => x.by).sort();
  assert.deepEqual(byStatus("model_not_allowed"), ["old", "plain"]);
  assert.deepEqual(byStatus("verified"), ["new"]);
  rmSync(root, { recursive: true, force: true });
});

test("verify: malformed v2 fields make the attestation invalid", () => {
  const root = repo();
  const att = createAttestation({ root, by: "r", verdict: "pass", subjects: ["src/export.ts"], against: ["specs/export.md"] });
  save(root, { ...att, against: [{ path: "specs/export.md", sha256: "nothex" }] });
  assert.equal(verifyAttestations({ root }).failures[0]!.status, "invalid");
  save(root, { ...att, checks: [{ command: "x", exitCode: "0" as unknown as number, witnessed: true }] });
  assert.equal(verifyAttestations({ root }).failures[0]!.status, "invalid");
  rmSync(root, { recursive: true, force: true });
});

test("verify: an against path that escapes the repo is invalid and never read", () => {
  const root = repo();
  const att = createAttestation({ root, by: "r", verdict: "pass", subjects: ["src/export.ts"], against: ["specs/export.md"] });
  save(root, { ...att, against: [{ path: "../../etc/passwd", sha256: "0".repeat(64) }] });
  const r = verifyAttestations({ root });
  assert.equal(r.failures[0]!.status, "invalid");
  rmSync(root, { recursive: true, force: true });
});

test("glob: ** spans folders, * stays inside one", () => {
  assert.ok(globToRegExp("docs/**").test("docs/a/b.md"));
  assert.ok(globToRegExp("**/*.md").test("README.md"));
  assert.ok(globToRegExp("**/*.md").test("a/b/c.md"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("*.lock").test("a.lockfile"));
  assert.ok(globToRegExp("file?.txt").test("file1.txt"));
  assert.ok(!globToRegExp("a.b").test("axb"));
});

test("coverage: a changed file with no verdict is refused (uncovered); attested ones pass", () => {
  const root = gitRepo();
  writeFileSync(join(root, "src/export.ts"), "export const x = 2;\n");
  writeFileSync(join(root, "src/other.ts"), "export const y = 3;\n");
  save(root, createAttestation({ root, by: "reviewer", verdict: "pass", subjects: ["src/export.ts"], now: NOW }));
  const policy: Policy = { schema: POLICY_SCHEMA, coverage: { mode: "diff", base: "main" } };
  const r = verifyAttestations({ root, policy });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures.map((f) => [f.status, f.subject]), [["uncovered", "src/other.ts"]]);

  save(root, createAttestation({ root, by: "reviewer", verdict: "pass", subjects: ["src/other.ts"], now: NOW }));
  assert.equal(verifyAttestations({ root, policy }).ok, true);
  rmSync(root, { recursive: true, force: true });
});

test("coverage: committed, untracked and ignored files; deleted files and .slipmark are left out", () => {
  const root = gitRepo();
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "src/export.ts"), "export const x = 9;\n");
  git("commit", "-qam", "change");
  writeFileSync(join(root, "src/new.ts"), "export const z = 1;\n");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/notes.md"), "notes\n");
  git("rm", "-q", "src/other.ts");
  save(root, createAttestation({ root, by: "reviewer", verdict: "pass", subjects: ["specs/export.md"], now: NOW }));

  assert.deepEqual(changedFiles(root, "main").filter((f) => !f.startsWith(".slipmark/")), ["docs/notes.md", "src/export.ts", "src/new.ts"]);
  const r = verifyAttestations({ root, policy: { schema: POLICY_SCHEMA, coverage: { mode: "diff", base: "main", ignore: ["docs/**"] } } });
  assert.deepEqual(r.failures.map((f) => f.subject).sort(), ["src/export.ts", "src/new.ts"]);
  rmSync(root, { recursive: true, force: true });
});

test("coverage: a required file that is also changed is reported once", () => {
  const root = gitRepo();
  writeFileSync(join(root, "src/export.ts"), "export const x = 2;\n");
  save(root, createAttestation({ root, by: "reviewer", verdict: "pass", subjects: ["specs/export.md"], now: NOW }));
  const r = verifyAttestations({ root, require: ["src/export.ts"], policy: { schema: POLICY_SCHEMA, coverage: { mode: "diff", base: "main" } } });
  assert.deepEqual(r.failures.map((f) => f.status), ["unattested"]);
  rmSync(root, { recursive: true, force: true });
});

test("coverage: a missing base is an error, never a silent pass", () => {
  const root = gitRepo();
  save(root, createAttestation({ root, by: "reviewer", verdict: "pass", subjects: ["src/export.ts"], now: NOW }));
  assert.throws(
    () => verifyAttestations({ root, policy: { schema: POLICY_SCHEMA, coverage: { mode: "diff", base: "origin/nope" } } }),
    /can't find the base "origin\/nope".*fetch-depth: 0/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("policy: .slipmark/policy.json is read automatically, and malformed ones are rejected", () => {
  const root = gitRepo();
  writeFileSync(join(root, "src/other.ts"), "changed\n");
  save(root, createAttestation({ root, by: "reviewer", verdict: "pass", subjects: ["src/export.ts"], now: NOW }));
  writeFileSync(join(root, ".slipmark/policy.json"), JSON.stringify({ schema: POLICY_SCHEMA, coverage: { mode: "diff", base: "main" } }));
  assert.equal(loadPolicy(root)!.coverage!.base, "main");
  const r = verifyAttestations({ root });
  assert.deepEqual(r.failures.map((f) => f.status), ["uncovered"]);
  assert.equal(verifyAttestations({ root, policy: null }).ok, true);

  writeFileSync(join(root, ".slipmark/policy.json"), JSON.stringify({ schema: "nope" }));
  assert.throws(() => loadPolicy(root), /must have "schema"/);
  writeFileSync(join(root, ".slipmark/policy.json"), JSON.stringify({ schema: POLICY_SCHEMA, coverage: { mode: "all" } }));
  assert.throws(() => loadPolicy(root), /coverage needs/);
  writeFileSync(join(root, ".slipmark/policy.json"), "{ not json");
  assert.throws(() => loadPolicy(root), /not valid JSON/);
  rmSync(root, { recursive: true, force: true });
});

const CLI = resolve("dist/src/cli.js");
const cli = (cwd: string, ...args: string[]) => spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });

test("cli: attest --run --against --check --model, then verify --coverage", () => {
  const root = gitRepo();
  writeFileSync(join(root, "src/export.ts"), "export const x = 2;\n");
  const a = cli(root, "attest", "--by", "reviewer", "--verdict", "pass", "--subject", "src/export.ts",
    "--against", "specs/export.md", "--run", "node -e \"process.exit(0)\"", "--check", "npm run lint=0", "--model", "claude-opus-5-5");
  assert.equal(a.status, 0, a.stderr);
  const file = join(root, DIR, "reviewer--src_export.ts.json");
  const att = JSON.parse(readFileSync(file, "utf8")) as Attestation;
  assert.equal(att.schema, ATTESTATION_SCHEMA_V2);
  assert.deepEqual(att.checks!.map((c) => [c.command, c.exitCode, c.witnessed]), [["node -e \"process.exit(0)\"", 0, true], ["npm run lint", 0, false]]);
  assert.equal(att.agent!.model, "claude-opus-5-5");

  assert.equal(cli(root, "verify", "--coverage", "diff", "--base", "main").status, 0);
  writeFileSync(join(root, "src/other.ts"), "changed\n");
  const v = cli(root, "verify", "--coverage", "diff", "--base", "main");
  assert.equal(v.status, 1);
  assert.match(v.stdout, /uncovered\s+src\/other\.ts changed since main/);
  assert.equal(cli(root, "verify", "--coverage", "diff", "--base", "main", "--ignore", "src/other.ts").status, 0);
  rmSync(root, { recursive: true, force: true });
});

test("cli: failing --run refuses a pass with exit 2; missing base exits 2; bad --check exits 2", () => {
  const root = gitRepo();
  const a = cli(root, "attest", "--by", "qa", "--verdict", "pass", "--subject", "src/export.ts", "--run", "node -e \"process.exit(4)\"");
  assert.equal(a.status, 2);
  assert.match(a.stderr, /refusing to record "pass"/);
  const v = cli(root, "verify", "--coverage", "diff", "--base", "origin/nope");
  assert.equal(v.status, 2);
  assert.match(v.stderr, /fetch-depth: 0/);
  const c = cli(root, "attest", "--by", "qa", "--verdict", "pass", "--subject", "src/export.ts", "--check", "npm test");
  assert.equal(c.status, 2);
  rmSync(root, { recursive: true, force: true });
});

// Review findings, 2026-10-23: each of these used to pass when it should refuse.

test("coverage: a changed file turned into a link outside the repo, or a broken link, is refused", () => {
  const root = gitRepo();
  save(root, createAttestation({ root, by: "reviewer", verdict: "pass", subjects: ["specs/export.md"], now: NOW }));
  rmSync(join(root, "src/other.ts"));
  symlinkSync("/etc/hostname", join(root, "src/other.ts"));
  rmSync(join(root, "src/export.ts"));
  symlinkSync("/nonexistent/file", join(root, "src/export.ts"));
  const r = verifyAttestations({ root, policy: { schema: POLICY_SCHEMA, coverage: { mode: "diff", base: "main" } } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures.map((f) => [f.status, f.subject]).sort(), [["invalid", "src/export.ts"], ["invalid", "src/other.ts"]]);
  rmSync(root, { recursive: true, force: true });
});

test("coverage: a base that looks like a git option is rejected, never turned into HEAD", () => {
  const root = gitRepo();
  writeFileSync(join(root, "src/other.ts"), "changed\n");
  execFileSync("git", ["commit", "-qam", "c"], { cwd: root });
  save(root, createAttestation({ root, by: "reviewer", verdict: "pass", subjects: ["src/export.ts"], now: NOW }));
  assert.throws(() => verifyAttestations({ root, policy: { schema: POLICY_SCHEMA, coverage: { mode: "diff", base: "--independent" } } }), /must be a git ref/);
  writeFileSync(join(root, ".slipmark/policy.json"), JSON.stringify({ schema: POLICY_SCHEMA, coverage: { mode: "diff", base: "-x" } }));
  assert.throws(() => loadPolicy(root), /must be a git ref/);
  const v = cli(root, "verify", "--no-policy", "--coverage", "diff", "--base", "--independent");
  assert.equal(v.status, 2);
  rmSync(root, { recursive: true, force: true });
});

test("verify: a v1 attestation is judged on v1 fields only", () => {
  const root = repo();
  const att = createAttestation({ root, by: "r", verdict: "pass", subjects: ["src/export.ts"] });
  writeAttestation(join(root, DIR, "v1.json"), { ...att, against: {} as unknown as [], checks: [{ command: "x", exitCode: 1, witnessed: true }] });
  const r = verifyAttestations({ root });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  rmSync(root, { recursive: true, force: true });
});

test("verify: a hand-edited pass over a claimed failed check is refused too", () => {
  const root = repo();
  const att = createAttestation({ root, by: "qa", verdict: "pass", subjects: ["src/export.ts"], checks: [{ command: "npm test", exitCode: 0 }] });
  save(root, { ...att, checks: [{ command: "npm test", exitCode: 1, witnessed: false }] });
  const r = verifyAttestations({ root });
  assert.equal(r.failures[0]!.status, "check_failed");
  rmSync(root, { recursive: true, force: true });
});

test("policy: arrays, null sections and missing values are rejected", () => {
  const root = repo();
  mkdirSync(join(root, ".slipmark"), { recursive: true });
  const bad = [
    Object.assign([], { schema: POLICY_SCHEMA }),
    { schema: POLICY_SCHEMA, models: null },
    { schema: POLICY_SCHEMA, coverage: null },
  ];
  for (const p of bad) {
    writeFileSync(join(root, ".slipmark/policy.json"), JSON.stringify(Array.isArray(p) ? p : p));
    assert.throws(() => loadPolicy(root));
  }
  rmSync(root, { recursive: true, force: true });
});

test("cli: a flag with no value is an error, not ignored", () => {
  const root = gitRepo();
  save(root, createAttestation({ root, by: "r", verdict: "pass", subjects: ["src/export.ts"], now: NOW }));
  for (const args of [["verify", "--coverage"], ["verify", "--coverage", "diff", "--base"], ["verify", "--require"], ["verify", "--require", "--json"]]) {
    const v = cli(root, ...args);
    assert.equal(v.status, 2, args.join(" "));
    assert.match(v.stderr, /needs a value/);
  }
  const a = cli(root, "attest", "--by", "r", "--verdict", "pass", "--subject", "src/export.ts", "--run");
  assert.equal(a.status, 2);
  rmSync(root, { recursive: true, force: true });
});

test("coverage: a changed link to a folder inside the repo is refused, not mistaken for a submodule", () => {
  const root = gitRepo();
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  mkdirSync(join(root, "configs/prod"), { recursive: true });
  mkdirSync(join(root, "configs/evil"), { recursive: true });
  writeFileSync(join(root, "configs/prod/a.json"), "{}\n");
  writeFileSync(join(root, "configs/evil/a.json"), "{\"x\":1}\n");
  symlinkSync("configs/prod", join(root, "active"));
  git("add", ".");
  git("commit", "-qm", "link");
  git("branch", "-f", "base");
  unlinkSync(join(root, "active")); // removes the link itself; rmSync refuses a link to a folder on macOS
  symlinkSync("configs/evil", join(root, "active"));
  symlinkSync("configs/prod", join(root, "fresh-link"));
  save(root, createAttestation({ root, by: "reviewer", verdict: "pass", subjects: ["specs/export.md"], now: NOW }));
  const r = verifyAttestations({ root, policy: { schema: POLICY_SCHEMA, coverage: { mode: "diff", base: "base" } } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures.map((f) => [f.status, f.subject]).sort(), [["invalid", "active"], ["invalid", "fresh-link"]]);
  rmSync(root, { recursive: true, force: true });
});

test("coverage: HEAD as the base is rejected; an empty models.allow says so; notes may start with --", () => {
  const root = gitRepo();
  assert.throws(() => verifyAttestations({ root, policy: { schema: POLICY_SCHEMA, coverage: { mode: "diff", base: "HEAD" } } }), /compare the branch with itself/);
  save(root, createAttestation({ root, by: "r", verdict: "pass", subjects: ["src/export.ts"], now: NOW }));
  const m = verifyAttestations({ root, policy: { schema: POLICY_SCHEMA, models: { allow: [] } } });
  assert.match(m.failures[0]!.message, /Policy allows: no models/);
  const a = cli(root, "attest", "--by", "r", "--verdict", "pass", "--subject", "src/other.ts", "--note", "--odd note");
  assert.equal(a.status, 0, a.stderr);
  rmSync(root, { recursive: true, force: true });
});

test("coverage: refuses to run from a subfolder, where git would only see that folder", () => {
  const root = gitRepo();
  writeFileSync(join(root, "src/other.ts"), "changed\n");
  const sub = join(root, "specs");
  assert.throws(() => verifyAttestations({ root: sub, policy: { schema: POLICY_SCHEMA, coverage: { mode: "diff", base: "main" } } }), /repository root/);
  const v = cli(sub, "verify", "--coverage", "diff", "--base", "main");
  assert.equal(v.status, 2);
  rmSync(root, { recursive: true, force: true });
});

test("policy: running from a subfolder never silently drops the root's policy", () => {
  const root = gitRepo();
  mkdirSync(join(root, "pkg"));
  writeFileSync(join(root, "pkg/p.ts"), "p\n");
  mkdirSync(join(root, ".slipmark"), { recursive: true });
  writeFileSync(join(root, ".slipmark/policy.json"), JSON.stringify({ schema: POLICY_SCHEMA, models: { allow: ["x"] } }));
  const sub = join(root, "pkg");
  save(sub, createAttestation({ root: sub, by: "r", verdict: "pass", subjects: ["p.ts"], now: NOW }));
  assert.throws(() => verifyAttestations({ root: sub }), /at the repository root/);
  assert.equal(cli(sub, "verify").status, 2);
  assert.equal(cli(sub, "verify", "--no-policy").status, 0);
  rmSync(root, { recursive: true, force: true });
});
