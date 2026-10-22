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
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const ATTESTATION_SCHEMA = "slipmark/attestation@1";

/** Verdicts that clear the gate. Anything else blocks. */
export const PASSING_VERDICTS = ["pass", "cleared"] as const;
export type Verdict = "pass" | "cleared" | "fail" | "blocked" | (string & {});

export interface AttestedSubject {
  /** Path relative to the repo root, forward slashes. */
  path: string;
  /** Lowercase hex SHA-256 of the file's bytes at the moment of the verdict. */
  sha256: string;
}

export interface Attestation {
  schema: typeof ATTESTATION_SCHEMA;
  /** Who gave the verdict, e.g. "security-audit-agent". */
  by: string;
  verdict: Verdict;
  /** ISO timestamp. Informational. */
  at: string;
  subjects: AttestedSubject[];
  /** Optional free text from the agent. Informational. */
  note?: string;
}

export type CheckStatus =
  | "verified"
  | "hash_mismatch"
  | "subject_missing"
  | "verdict_not_passing"
  | "unattested"
  | "invalid";

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

/** Build an attestation for the given subjects as they are on disk now. */
export function createAttestation(opts: {
  root?: string;
  subjects: string[];
  verdict: Verdict;
  by: string;
  note?: string;
  now?: Date;
}): Attestation {
  const root = resolve(opts.root ?? process.cwd());
  if (!opts.by) throw new Error("attestation needs --by (who gave the verdict)");
  if (!opts.verdict) throw new Error("attestation needs --verdict");
  if (opts.subjects.length === 0) throw new Error("attestation needs at least one --subject");

  const subjects = opts.subjects.map((s) => {
    const abs = resolveSubject(root, s);
    if (!abs) throw new Error(`subject must be a path inside the repo: ${s}`);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`subject not found: ${s}`);
    return { path: toPosix(relative(root, abs)), sha256: sha256File(abs) };
  });

  const att: Attestation = {
    schema: ATTESTATION_SCHEMA,
    by: opts.by,
    verdict: opts.verdict,
    at: (opts.now ?? new Date()).toISOString(),
    subjects,
  };
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

function isAttestation(v: unknown): v is Attestation {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    a.schema === ATTESTATION_SCHEMA &&
    typeof a.by === "string" &&
    typeof a.verdict === "string" &&
    Array.isArray(a.subjects) &&
    a.subjects.length > 0 &&
    a.subjects.every(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof (s as AttestedSubject).path === "string" &&
        typeof (s as AttestedSubject).sha256 === "string" &&
        /^[0-9a-f]{64}$/.test((s as AttestedSubject).sha256),
    )
  );
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
}): VerifyReport {
  const root = resolve(opts.root ?? process.cwd());
  const dir = resolve(root, opts.dir ?? ".slipmark/attestations");
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
    const att = parsed;
    const passing = (PASSING_VERDICTS as readonly string[]).includes(att.verdict);

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
      results.push({ ...base, status: "verified", message: `${att.by} verified ${s.path}` });
    }
  }

  for (const req of opts.require ?? []) {
    const abs = resolveSubject(root, req);
    const key = abs ? toPosix(relative(root, abs)) : req;
    if (!abs || !covered.has(key)) {
      results.push({ status: "unattested", subject: req, message: `no passing, current attestation covers ${req}` });
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
