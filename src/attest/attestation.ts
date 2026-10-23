/**
 * Verdict attestation: make agents prove what they checked.
 *
 * An agent that reviews, audits or tests something writes an attestation: its
 * verdict, plus the SHA-256 of every file it actually read. Before anything
 * ships, `verifyAttestations` re-hashes those files on the tree as it stands
 * now and refuses if anything moved.
 *
 * Why: a verdict on its own proves nothing. An agent (or a CI job checking the
 * wrong branch) can report "passed" about a file that has since changed, or that
 * it never looked at. Binding the verdict to a content hash turns "trust me"
 * into something a gate can check deterministically, with no model calls.
 *
 * Everything here is pure Node: `node:crypto`, `node:fs`, `node:path`.
 */
import { createHash } from "node:crypto";
import { checkSignature, type AttestationSignature, type SignatureCheck, type SignaturePolicy } from "./signing.js";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const ATTESTATION_SCHEMA = "slipmark/attestation@1";
/**
 * v2 adds what the verdict was checked against, checks Slipmark ran itself, and
 * which model gave it. `attest` only writes @2 when one of those is used, so
 * older verifiers keep reading plain attestations.
 */
export const ATTESTATION_SCHEMA_V2 = "slipmark/attestation@2";
export const POLICY_SCHEMA = "slipmark/policy@1";
export const POLICY_FILE = ".slipmark/policy.json";

/** Always left out of coverage: the attestations themselves change with every verdict. */
export const COVERAGE_ALWAYS_IGNORED = [".slipmark/**"];

/** Verdicts that clear the gate. Anything else blocks. */
export const PASSING_VERDICTS = ["pass", "cleared"] as const;
export type Verdict = "pass" | "cleared" | "fail" | "blocked" | (string & {});

export interface AttestedSubject {
  /** Path relative to the repo root, forward slashes. */
  path: string;
  /** Lowercase hex SHA-256 of the file's bytes at the moment of the verdict. */
  sha256: string;
}

/**
 * A check behind the verdict. `witnessed: true` means Slipmark ran the command
 * itself (`attest --run`). `witnessed: false` is the attester's claim
 * (`attest --check`) and is reported as such, never trusted.
 */
export interface AttestedCheck {
  command: string;
  exitCode: number;
  /** SHA-256 of stdout followed by stderr. Witnessed checks only. */
  outputSha256?: string;
  durationMs?: number;
  witnessed: boolean;
}

/** Who gave the verdict. Claimed, used only to match policies. */
export interface AgentInfo {
  model?: string;
  harness?: string;
  harnessVersion?: string;
}

export type AttesterKind = "agent" | "tool" | "human";

export interface Attestation {
  schema: typeof ATTESTATION_SCHEMA | typeof ATTESTATION_SCHEMA_V2;
  /** Who gave the verdict, e.g. "security-audit-agent". */
  by: string;
  verdict: Verdict;
  /** ISO timestamp. Informational. */
  at: string;
  subjects: AttestedSubject[];
  /** Optional free text from the agent. Informational. */
  note?: string;
  /** v2. Claimed. Defaults to "agent". */
  kind?: AttesterKind;
  /** v2. Claimed. */
  agent?: AgentInfo;
  /** v2. Witnessed. Files the verdict was checked against (a spec, a checklist). Gated like subjects. */
  against?: AttestedSubject[];
  /** v2. Checks behind the verdict. */
  checks?: AttestedCheck[];
  /** Sigstore signature over the rest of the attestation, made where the verdict was given. See signing.ts. */
  signature?: AttestationSignature;
}

/** `.slipmark/policy.json`. Optional: without it, verify behaves exactly as before. */
export interface Policy {
  schema: typeof POLICY_SCHEMA;
  coverage?: { mode: "diff"; base: string; ignore?: string[] };
  models?: { allow: string[] };
  /** Signed verdicts: who may sign, and whether unsigned verdicts count. */
  signatures?: SignaturePolicy;
}

export type CheckStatus =
  | "verified"
  | "hash_mismatch"
  | "subject_missing"
  | "verdict_not_passing"
  | "unattested"
  | "invalid"
  | "uncovered"
  | "against_changed"
  | "check_failed"
  | "model_not_allowed"
  | "unsigned"
  | "signature_invalid"
  | "signer_not_trusted";

export interface CheckResult {
  status: CheckStatus;
  /** The attestation file, relative to root (absent for `unattested`). */
  attestation?: string;
  /** The subject path this result is about, when there is one. */
  subject?: string;
  by?: string;
  verdict?: string;
  expected?: string;
  actual?: string;
  /** Who signed the verdict, when it carries a valid signature: for GitHub Actions, the workflow and ref. */
  signer?: string;
  message: string;
}

export interface VerifyReport {
  ok: boolean;
  checked: number;
  results: CheckResult[];
  failures: CheckResult[];
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** True when `rel` (a path relative to some root) points outside that root. */
function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Resolve a subject path against the root and refuse anything that escapes it.
 * Attestations are untrusted input: "../../etc/passwd" must never be hashed,
 * and neither may a symlink inside the repo that points outside it.
 */
export function resolveSubject(root: string, subject: string): string | null {
  if (!subject || isAbsolute(subject)) return null;
  const base = resolve(root);
  const abs = resolve(base, subject);
  const rel = relative(base, abs);
  if (rel === "" || escapes(rel)) return null;
  // Follow symlinks (in the file or any parent folder) and check again against the real root.
  if (existsSync(abs)) {
    try {
      const realRel = relative(realpathSync(base), realpathSync(abs));
      if (realRel === "" || escapes(realRel)) return null;
    } catch {
      return null;
    }
  }
  return abs;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** Run a check from the repo root and record what happened. */
export function runCheck(root: string, command: string): AttestedCheck {
  const started = Date.now();
  const r = spawnSync(command, { cwd: root, shell: true, maxBuffer: 256 * 1024 * 1024 });
  const exitCode = r.error ? 127 : (r.status ?? 128);
  const output = Buffer.concat([r.stdout ?? Buffer.alloc(0), r.stderr ?? Buffer.alloc(0)]);
  return {
    command,
    exitCode,
    outputSha256: createHash("sha256").update(output).digest("hex"),
    durationMs: Date.now() - started,
    witnessed: true,
  };
}

function hashFiles(root: string, paths: string[], label: string): AttestedSubject[] {
  return paths.map((s) => {
    const abs = resolveSubject(root, s);
    if (!abs) throw new Error(`${label} must be a path inside the repo: ${s}`);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`${label} not found: ${s}`);
    return { path: toPosix(relative(root, abs)), sha256: sha256File(abs) };
  });
}

export function isPassingVerdict(verdict: string): boolean {
  return (PASSING_VERDICTS as readonly string[]).includes(verdict);
}

/**
 * Build an attestation for the given subjects as they are on disk now.
 *
 * `run` commands are executed here, before anything is written. A passing
 * verdict is refused if any of them (or any claimed check) exited non-zero.
 */
export function createAttestation(opts: {
  root?: string;
  subjects: string[];
  verdict: Verdict;
  by: string;
  note?: string;
  now?: Date;
  /** Files the verdict was checked against. */
  against?: string[];
  /** Commands Slipmark runs and records (witnessed). */
  run?: string[];
  /** Checks the attester says it ran (claimed). */
  checks?: { command: string; exitCode: number }[];
  kind?: AttesterKind;
  agent?: AgentInfo;
  /** Test hook: replaces runCheck. */
  runner?: (root: string, command: string) => AttestedCheck;
}): Attestation {
  const root = resolve(opts.root ?? process.cwd());
  if (!opts.by) throw new Error("attestation needs --by (who gave the verdict)");
  if (!opts.verdict) throw new Error("attestation needs --verdict");
  if (opts.subjects.length === 0) throw new Error("attestation needs at least one --subject");
  if (opts.kind && !["agent", "tool", "human"].includes(opts.kind)) throw new Error(`--kind must be agent, tool or human, not ${opts.kind}`);

  const subjects = hashFiles(root, opts.subjects, "subject");
  const against = hashFiles(root, opts.against ?? [], "--against file");

  const runner = opts.runner ?? runCheck;
  const checks: AttestedCheck[] = [
    ...(opts.run ?? []).map((c) => runner(root, c)),
    ...(opts.checks ?? []).map((c) => ({ command: c.command, exitCode: c.exitCode, witnessed: false })),
  ];
  const failed = checks.filter((c) => c.exitCode !== 0);
  if (failed.length > 0 && isPassingVerdict(opts.verdict)) {
    const what = failed.map((c) => `"${c.command}" exited ${c.exitCode}`).join(", ");
    throw new Error(`refusing to record "${opts.verdict}": ${what}. Record --verdict fail instead, or fix it and attest again.`);
  }

  const agent: AgentInfo = {};
  if (opts.agent?.model) agent.model = opts.agent.model;
  if (opts.agent?.harness) agent.harness = opts.agent.harness;
  if (opts.agent?.harnessVersion) agent.harnessVersion = opts.agent.harnessVersion;
  const v2 = against.length > 0 || checks.length > 0 || Object.keys(agent).length > 0 || opts.kind !== undefined;

  const att: Attestation = {
    schema: v2 ? ATTESTATION_SCHEMA_V2 : ATTESTATION_SCHEMA,
    by: opts.by,
    verdict: opts.verdict,
    at: (opts.now ?? new Date()).toISOString(),
    subjects,
  };
  if (opts.kind) att.kind = opts.kind;
  if (Object.keys(agent).length > 0) att.agent = agent;
  if (against.length > 0) att.against = against;
  if (checks.length > 0) att.checks = checks;
  if (opts.note) att.note = opts.note;
  return att;
}

/** Default file name for an attestation: one per agent per first subject. */
export function defaultAttestationPath(dir: string, att: Attestation): string {
  const first = att.subjects[0]?.path ?? "subject";
  const slug = `${att.by}--${first}`.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160);
  return join(dir, `${slug}.json`);
}

export function writeAttestation(filePath: string, att: Attestation): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(att, null, 2) + "\n", "utf8");
}

function isSubjectList(v: unknown, allowEmpty: boolean): boolean {
  return (
    Array.isArray(v) &&
    (allowEmpty || v.length > 0) &&
    v.every(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof (s as AttestedSubject).path === "string" &&
        typeof (s as AttestedSubject).sha256 === "string" &&
        /^[0-9a-f]{64}$/.test((s as AttestedSubject).sha256),
    )
  );
}

function isCheckList(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (c) =>
        c &&
        typeof c === "object" &&
        typeof (c as AttestedCheck).command === "string" &&
        Number.isInteger((c as AttestedCheck).exitCode) &&
        typeof (c as AttestedCheck).witnessed === "boolean",
    )
  );
}

function isAttestation(v: unknown): v is Attestation {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  const base =
    typeof a.by === "string" && typeof a.verdict === "string" && isSubjectList(a.subjects, false);
  if (a.signature !== undefined && !(a.signature && typeof a.signature === "object" && (a.signature as { bundle?: unknown }).bundle && typeof (a.signature as { bundle?: unknown }).bundle === "object")) return false;
  if (a.schema === ATTESTATION_SCHEMA) return base;
  if (a.schema !== ATTESTATION_SCHEMA_V2 || !base) return false;
  if (a.against !== undefined && !isSubjectList(a.against, true)) return false;
  if (a.checks !== undefined && !isCheckList(a.checks)) return false;
  if (a.kind !== undefined && !["agent", "tool", "human"].includes(a.kind as string)) return false;
  if (a.agent !== undefined) {
    if (!a.agent || typeof a.agent !== "object") return false;
    const model = (a.agent as AgentInfo).model;
    if (model !== undefined && typeof model !== "string") return false;
  }
  return true;
}

/** Glob to RegExp. Supports `**`, `*` and `?`, matched against the whole repo-relative path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** Read and check `.slipmark/policy.json`. Returns null when there is none. Throws when it is malformed. */
export function loadPolicy(root: string): Policy | null {
  const file = join(resolve(root), POLICY_FILE);
  if (!existsSync(file)) {
    // Run from a subfolder, the repository's own policy would be missed and its rules silently dropped. Refuse instead.
    let top: string | null = null;
    try {
      top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(root), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      top = null; // not a git repository: nothing above to miss
    }
    if (top && realpathSync(top) !== realpathSync(resolve(root)) && existsSync(join(top, POLICY_FILE))) {
      throw new Error(`${POLICY_FILE} is at the repository root (${top}). Run from there, or pass --no-policy to skip it on purpose.`);
    }
    return null;
  }
  let p: unknown;
  try {
    p = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${POLICY_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const policy = p as Policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || policy.schema !== POLICY_SCHEMA) {
    throw new Error(`${POLICY_FILE} must have "schema": "${POLICY_SCHEMA}"`);
  }
  const cov = policy.coverage;
  if (cov !== undefined) {
    if (!cov || typeof cov !== "object" || cov.mode !== "diff" || typeof cov.base !== "string" || !cov.base) {
      throw new Error(`${POLICY_FILE}: coverage needs "mode": "diff" and a "base" ref`);
    }
    checkBase(cov.base);
    if (cov.ignore !== undefined && !(Array.isArray(cov.ignore) && cov.ignore.every((g) => typeof g === "string"))) {
      throw new Error(`${POLICY_FILE}: coverage.ignore must be a list of globs`);
    }
  }
  const models = policy.models;
  if (models !== undefined && !(models && typeof models === "object" && Array.isArray(models.allow) && models.allow.every((m) => typeof m === "string"))) {
    throw new Error(`${POLICY_FILE}: models.allow must be a list of model names`);
  }
  const sig = policy.signatures;
  if (sig !== undefined) {
    if (!sig || typeof sig !== "object" || Array.isArray(sig)) throw new Error(`${POLICY_FILE}: signatures must be an object`);
    if (sig.require !== undefined && typeof sig.require !== "boolean") throw new Error(`${POLICY_FILE}: signatures.require must be true or false`);
    if (sig.trusted !== undefined && !(Array.isArray(sig.trusted) && sig.trusted.every((t) => typeof t === "string" && t.length > 0))) {
      throw new Error(`${POLICY_FILE}: signatures.trusted must be a list of signer identities`);
    }
    if (sig.issuer !== undefined && !(typeof sig.issuer === "string" && /^https:\/\//.test(sig.issuer))) throw new Error(`${POLICY_FILE}: signatures.issuer must be an https URL`);
    if (sig.require && !sig.trusted?.length) {
      throw new Error(`${POLICY_FILE}: signatures.require needs a "trusted" list, for example the workflow that runs your review agent at refs/heads/main`);
    }
  }
  return policy;
}

/** A coverage base is a ref, never an option. `--independent` would silently make the merge base HEAD. */
export function checkBase(base: string): void {
  if (!base || base.startsWith("-") || /[\0\s]/.test(base)) {
    throw new Error(`coverage base must be a git ref such as origin/main, not "${base}"`);
  }
  if (base === "HEAD" || base === "@") {
    throw new Error(`coverage base "${base}" would compare the branch with itself and cover nothing. Use the branch you merge into, such as origin/main`);
  }
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Files changed since the merge base with `base`, as the tree is now: committed,
 * staged, unstaged and untracked. Deleted files are left out (there is nothing
 * left to attest). Paths are relative to `root`.
 */
export function changedFiles(root: string, base: string): string[] {
  checkBase(base);
  // Coverage must see the whole repository. Run from a subfolder, git would only report that folder.
  let top: string;
  try {
    top = git(root, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new Error("coverage: this folder is not inside a git repository");
  }
  if (realpathSync(top) !== realpathSync(root)) {
    throw new Error(`coverage: run from the repository root (${top}), not a subfolder. From a subfolder it would miss changes elsewhere in the repo.`);
  }
  let mergeBase: string;
  try {
    const commit = git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).trim();
    mergeBase = git(root, ["merge-base", commit, "HEAD"]).trim();
  } catch {
    throw new Error(
      `coverage: can't find the base "${base}" in this checkout. ` +
        `In GitHub Actions, use actions/checkout with fetch-depth: 0.`,
    );
  }
  const split = (out: string) => out.split("\0").filter(Boolean);
  const changed = split(git(root, ["diff", "--name-only", "-z", "--relative", "--diff-filter=d", mergeBase, "--"]));
  const untracked = split(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...changed, ...untracked])].sort();
}

/** List *.json files in the attestation directory (non-recursive, sorted). */
export function listAttestationFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * The gate. Re-hashes every attested subject on the tree as it is now.
 *
 * Fails on: a subject whose bytes changed since the verdict (hash_mismatch), a
 * subject that no longer exists, a verdict that isn't passing, a malformed
 * attestation, or a `require`d subject that no attestation covers.
 *
 * Pure apart from reading files under `root`.
 */
export function verifyAttestations(opts: {
  root?: string;
  dir?: string;
  require?: string[];
  /** Policy to apply. Omitted: read `.slipmark/policy.json` if present. `null`: no policy. */
  policy?: Policy | null;
  /** Signature checks by attestation file (repo-relative), from checkSignatures. Signed attestations without one count as unsigned. */
  signatures?: Map<string, SignatureCheck>;
}): VerifyReport {
  const root = resolve(opts.root ?? process.cwd());
  const dir = resolve(root, opts.dir ?? ".slipmark/attestations");
  const policy = opts.policy === undefined ? loadPolicy(root) : opts.policy;
  const results: CheckResult[] = [];
  const covered = new Set<string>();
  const files = listAttestationFiles(dir);

  for (const file of files) {
    const attRel = toPosix(relative(root, file));
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      results.push({ status: "invalid", attestation: attRel, message: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    if (!isAttestation(parsed)) {
      results.push({ status: "invalid", attestation: attRel, message: `not a ${ATTESTATION_SCHEMA} attestation` });
      continue;
    }
    // A v1 attestation is judged on v1 fields only. Anything else in it is ignored.
    const att: Attestation =
      parsed.schema === ATTESTATION_SCHEMA
        ? { schema: parsed.schema, by: parsed.by, verdict: parsed.verdict, at: parsed.at, subjects: parsed.subjects, note: parsed.note }
        : parsed;
    const passing = isPassingVerdict(att.verdict);
    const sigPolicy = policy?.signatures;
    const sigCheck = (parsed as { signature?: unknown }).signature !== undefined ? opts.signatures?.get(attRel) : undefined;
    const signer = sigCheck?.state === "valid" && sigCheck.trusted ? sigCheck.identity : undefined;

    // Conditions on the attestation as a whole. Any of these and none of its
    // subjects count, so --require and coverage report them as not covered too.
    const attFailures: CheckResult[] = [];
    const who = { attestation: attRel, by: att.by, verdict: att.verdict };
    for (const a of att.against ?? []) {
      const abs = resolveSubject(root, a.path);
      if (!abs) {
        attFailures.push({ ...who, subject: a.path, status: "invalid", message: `against path escapes the repo: ${a.path}` });
      } else if (!existsSync(abs) || !statSync(abs).isFile()) {
        attFailures.push({ ...who, subject: a.path, status: "against_changed", message: `${att.by} checked against ${a.path}, which no longer exists` });
      } else {
        const actual = sha256File(abs);
        if (actual !== a.sha256) {
          attFailures.push({
            ...who,
            subject: a.path,
            status: "against_changed",
            expected: a.sha256,
            actual,
            message: `${att.by} gave "${att.verdict}" against a different version of ${a.path}. It changed after the verdict.`,
          });
        }
      }
    }
    // Any failed check blocks, claimed or witnessed: a claim of failure can only make the gate stricter.
    for (const c of att.checks ?? []) {
      if (c.exitCode !== 0) {
        const how = c.witnessed ? "exited" : "was reported as exiting";
        attFailures.push({ ...who, status: "check_failed", message: `${att.by}: "${c.command}" ${how} ${c.exitCode} when the verdict was recorded` });
      }
    }
    const allow = policy?.models?.allow;
    if (allow && !(att.agent?.model && allow.includes(att.agent.model))) {
      const model = att.agent?.model ? `model ${att.agent.model}` : "no model recorded";
      attFailures.push({ ...who, status: "model_not_allowed", message: `${att.by}: ${model}. Policy allows: ${allow.join(", ") || "no models"}` });
    }
    // A broken signature always refuses: something was changed after signing. Missing or untrusted ones refuse only when the policy requires signatures.
    if (sigCheck?.state === "invalid") {
      attFailures.push({ ...who, status: "signature_invalid", message: `${att.by}: ${sigCheck.reason}` });
    } else if (sigPolicy?.require) {
      if (!sigCheck || sigCheck.state === "unchecked") {
        attFailures.push({ ...who, status: "unsigned", message: `${att.by}: verdict isn't signed. Policy requires a signature from ${sigPolicy.trusted?.join(" or ")}` });
      } else if (sigCheck.state === "valid" && !sigCheck.trusted) {
        attFailures.push({ ...who, status: "signer_not_trusted", message: `${att.by}: signed by ${sigCheck.identity}, which the policy doesn't trust` });
      }
    }
    if (attFailures.length > 0) {
      results.push(...attFailures);
      continue;
    }

    for (const s of att.subjects) {
      const abs = resolveSubject(root, s.path);
      const base = { attestation: attRel, subject: s.path, by: att.by, verdict: att.verdict };
      if (!abs) {
        results.push({ ...base, status: "invalid", message: `subject path escapes the repo: ${s.path}` });
        continue;
      }
      const relKey = toPosix(relative(root, abs));
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        results.push({ ...base, status: "subject_missing", message: `${att.by} attested ${s.path}, which no longer exists` });
        continue;
      }
      const actual = sha256File(abs);
      if (actual !== s.sha256) {
        results.push({
          ...base,
          status: "hash_mismatch",
          expected: s.sha256,
          actual,
          message: `${att.by} gave "${att.verdict}" for a different version of ${s.path}. The file changed after the verdict.`,
        });
        continue;
      }
      if (!passing) {
        results.push({ ...base, status: "verdict_not_passing", message: `${att.by} gave "${att.verdict}" for ${s.path}` });
        continue;
      }
      covered.add(relKey);
      results.push({ ...base, status: "verified", ...(signer ? { signer } : {}), message: `${att.by} verified ${s.path}${signer ? ` (signed by ${signer})` : ""}` });
    }
  }

  const reported = new Set<string>();
  for (const req of opts.require ?? []) {
    const abs = resolveSubject(root, req);
    const key = abs ? toPosix(relative(root, abs)) : req;
    if (!abs || !covered.has(key)) {
      reported.add(key);
      results.push({ status: "unattested", subject: req, message: `no passing, current attestation covers ${req}` });
    }
  }

  const cov = policy?.coverage;
  if (cov) {
    const ignore = [...COVERAGE_ALWAYS_IGNORED, ...(cov.ignore ?? [])];
    for (const f of changedFiles(root, cov.base)) {
      const path = toPosix(f);
      if (covered.has(path) || reported.has(path) || matchesAny(path, ignore)) continue;
      // Only a real directory (a submodule, its own repository) is skipped. lstat, so a link is never mistaken for one.
      let entry;
      try {
        entry = lstatSync(join(root, path));
      } catch {
        entry = null;
      }
      if (entry?.isDirectory()) continue;
      const abs = resolveSubject(root, path);
      if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
        // A link out of the repo, a broken link, or anything else that can't be hashed. Never dropped silently.
        results.push({ status: "invalid", subject: path, message: `${path} changed since ${cov.base} but can't be verified: it is a link to a folder, outside the repo, or to nothing` });
        continue;
      }
      results.push({ status: "uncovered", subject: path, message: `${path} changed since ${cov.base} and no passing, current verdict covers it` });
    }
  }

  const failures = results.filter((r) => r.status !== "verified");
  const checked = results.length;
  // An empty run is not a pass: a gate with nothing to check proves nothing.
  const ok = failures.length === 0 && checked > 0;
  if (checked === 0) {
    const empty: CheckResult = { status: "unattested", message: `no attestations found in ${toPosix(relative(root, dir)) || "."}` };
    return { ok: false, checked: 0, results: [empty], failures: [empty] };
  }
  return { ok, checked, results, failures };
}

/**
 * Check the signature on every signed attestation in `dir`. Sigstore needs the network,
 * so this is the async step before verifyAttestations. When the policy requires
 * signatures and one can't be checked, it throws: that's "couldn't run", not a pass.
 */
export async function checkSignatures(opts: {
  root?: string;
  dir?: string;
  policy?: Policy | null;
  verify?: Parameters<typeof checkSignature>[2];
}): Promise<Map<string, SignatureCheck>> {
  const root = resolve(opts.root ?? process.cwd());
  const dir = resolve(root, opts.dir ?? ".slipmark/attestations");
  const sigPolicy = opts.policy?.signatures;
  const out = new Map<string, SignatureCheck>();
  for (const file of listAttestationFiles(dir)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue; // reported as invalid by verifyAttestations
    }
    if (!raw || typeof raw !== "object" || (raw as { signature?: unknown }).signature === undefined) continue;
    const check = await checkSignature(raw as Record<string, unknown>, sigPolicy, opts.verify);
    if (check.state === "unchecked" && sigPolicy?.require) throw new Error(`couldn't check signatures: ${check.reason}`);
    out.set(toPosix(relative(root, file)), check);
  }
  return out;
}

/** The whole gate, signatures included. */
export async function verifyWithSignatures(opts: {
  root?: string;
  dir?: string;
  require?: string[];
  policy?: Policy | null;
  verify?: Parameters<typeof checkSignature>[2];
}): Promise<VerifyReport> {
  const root = resolve(opts.root ?? process.cwd());
  const policy = opts.policy === undefined ? loadPolicy(root) : opts.policy;
  const signatures = await checkSignatures({ root, dir: opts.dir, policy, verify: opts.verify });
  return verifyAttestations({ root, dir: opts.dir, require: opts.require, policy, signatures });
}
