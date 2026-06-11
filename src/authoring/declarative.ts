/**
 * Declarative (config-only) authoring.
 *
 * Lets non-TypeScript users define a pack in plain JSON: signatures, system map,
 * constraints, and locks whose verification is expressed as assertions against
 * the output of a target command. This is the OSS adoption unlock — you do not
 * have to write code to protect your AI behavior.
 *
 * This module is PURE: it compiles a declarative pack into a runtime Pack given
 * an injected `runTarget` (how to actually produce output from a fixture). The
 * Node loader supplies a child_process-based runTarget; this keeps the compiler
 * environment-agnostic and unit-testable without spawning anything.
 */
import type { ExecutionTrace, FailedAssertion, LockDefinition, LockResult, Pack, SystemMap } from "../types.js";

export type AssertionType =
  | "contains"
  | "not_contains"
  | "matches"
  | "not_matches"
  | "equals"
  | "not_equals";

export interface DeclarativeAssertion {
  name: string;
  type: AssertionType;
  value: string;
  /** Case-insensitive comparison / matching. Default true. */
  ignoreCase?: boolean;
}

export interface DeclarativeTarget {
  /** Shell command that produces the output to assert on. If omitted, the fixture IS the output (golden mode). */
  command?: string;
  /** How the fixture is passed to the command. Default "stdin-json". */
  inputFormat?: "stdin-json" | "stdin-text";
}

export interface DeclarativeLock {
  key: string;
  name: string;
  scope: string;
  invariants: string[];
  likelyFiles?: string[];
  likelyModules?: string[];
  failureSignatures?: string[];
  watchedSymbols?: string[];
  target?: DeclarativeTarget;
  /** Arbitrary input passed to the target (or, in golden mode, the literal output). */
  fixture?: unknown;
  assertions: DeclarativeAssertion[];
  /** Message used when the lock drifts. */
  driftMessage?: string;
  /** Optional static execution trace to attach. */
  trace?: ExecutionTrace;
}

export interface DeclarativeSignature {
  key: string;
  label: string;
  description: string;
  assertionNames?: string[];
  /** Regex sources, e.g. "latest\\s+intent" or "/foo/i". Default flag: i. */
  patterns?: string[];
}

export interface DeclarativePack {
  id: string;
  signatures?: DeclarativeSignature[];
  signatureToModules?: Record<string, string[]>;
  baseConstraints?: string[];
  scopeConstraints?: Record<string, string[]>;
  scopeImpact?: Record<string, string>;
  signatureGoals?: Record<string, string>;
  signatureImpact?: Record<string, string>;
  diffKeywords?: string[];
  systemMap?: SystemMap;
  locks: DeclarativeLock[];
}

/** Produces the output text for a lock from its target + fixture. */
export type RunTarget = (target: DeclarativeTarget | undefined, fixture: unknown) => string;

function parsePattern(src: string): RegExp {
  const m = /^\/(.*)\/([a-z]*)$/.exec(src);
  if (m) {
    try {
      return new RegExp(m[1]!, m[2]);
    } catch {
      /* fall through */
    }
  }
  return new RegExp(src, "i");
}

/** Evaluate a lock's assertions against an output string. Returns the failures. */
export function evaluateAssertions(output: string, assertions: DeclarativeAssertion[]): FailedAssertion[] {
  const failed: FailedAssertion[] = [];
  for (const a of assertions) {
    const ci = a.ignoreCase !== false;
    const hay = ci ? output.toLowerCase() : output;
    const needle = ci ? a.value.toLowerCase() : a.value;
    let ok = true;
    let reason = "";
    switch (a.type) {
      case "contains":
        ok = hay.includes(needle);
        reason = ok ? "" : `Expected output to contain "${a.value}".`;
        break;
      case "not_contains":
        ok = !hay.includes(needle);
        reason = ok ? "" : `Expected output NOT to contain "${a.value}".`;
        break;
      case "matches": {
        const re = parsePattern(ci ? `/${a.value}/i` : a.value);
        ok = re.test(output);
        reason = ok ? "" : `Expected output to match /${a.value}/.`;
        break;
      }
      case "not_matches": {
        const re = parsePattern(ci ? `/${a.value}/i` : a.value);
        ok = !re.test(output);
        reason = ok ? "" : `Expected output NOT to match /${a.value}/.`;
        break;
      }
      case "equals":
        ok = hay.trim() === needle.trim();
        reason = ok ? "" : `Expected output to equal "${a.value}".`;
        break;
      case "not_equals":
        ok = hay.trim() !== needle.trim();
        reason = ok ? "" : `Expected output NOT to equal "${a.value}".`;
        break;
    }
    if (!ok) failed.push({ name: a.name, reason });
  }
  return failed;
}

/** Compile a declarative pack into a runtime Pack, given a target runner. */
export function compileDeclarativePack(decl: DeclarativePack, runTarget: RunTarget): Pack {
  if (!decl || typeof decl !== "object") throw new Error("declarative pack must be an object");
  if (!decl.id) throw new Error("declarative pack: `id` is required");
  if (!Array.isArray(decl.locks) || decl.locks.length === 0) {
    throw new Error("declarative pack: `locks` must be a non-empty array");
  }

  const locks: LockDefinition[] = decl.locks.map((dl) => compileLock(dl, runTarget));

  return {
    id: decl.id,
    signatures: (decl.signatures || []).map((s) => ({
      key: s.key,
      label: s.label,
      description: s.description,
      assertionNames: s.assertionNames || [],
      patterns: (s.patterns || []).map(parsePattern),
    })),
    signatureToModules: decl.signatureToModules || {},
    baseConstraints: decl.baseConstraints || [],
    scopeConstraints: decl.scopeConstraints || {},
    scopeImpact: decl.scopeImpact || {},
    signatureGoals: decl.signatureGoals || {},
    signatureImpact: decl.signatureImpact || {},
    diffKeywords: decl.diffKeywords || [],
    systemMap: decl.systemMap || { modules: [] },
    locks,
  };
}

function compileLock(dl: DeclarativeLock, runTarget: RunTarget): LockDefinition {
  if (!dl.key) throw new Error("declarative lock: `key` is required");
  if (!Array.isArray(dl.assertions) || dl.assertions.length === 0) {
    throw new Error(`declarative lock \`${dl.key}\`: \`assertions\` must be a non-empty array`);
  }
  return {
    key: dl.key,
    name: dl.name || dl.key,
    scope: dl.scope || "ai",
    invariants: dl.invariants || [],
    likelyFiles: dl.likelyFiles,
    likelyModules: dl.likelyModules,
    failureSignatures: dl.failureSignatures,
    watchedSymbols: dl.watchedSymbols,
    run(): LockResult {
      let output: string;
      try {
        output = runTarget(dl.target, dl.fixture);
      } catch (e) {
        return {
          status: "error",
          message: `target failed: ${e instanceof Error ? e.message : String(e)}`,
          failedAssertions: [],
          trace: dl.trace,
        };
      }
      const failed = evaluateAssertions(output, dl.assertions);
      if (failed.length === 0) {
        return { status: "pass", message: "all assertions held", failedAssertions: [], trace: dl.trace };
      }
      return {
        status: "drift",
        message: dl.driftMessage || `lock \`${dl.key}\` drifted: ${failed.length} assertion(s) failed`,
        failedAssertions: failed,
        trace: dl.trace,
      };
    },
  };
}
