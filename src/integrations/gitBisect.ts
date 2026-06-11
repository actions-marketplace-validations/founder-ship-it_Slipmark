/**
 * Git bisection host adapter.
 *
 * The engine's `bisectFirstFailing` is a pure algorithm that needs a probe:
 * "does the lock pass at this commit?". This adapter makes that real by checking
 * out each commit in a working tree and running a shell command (exit 0 = pass),
 * then restoring the original ref — turning the algorithm into a working
 * "git-bisect for AI behavior".
 *
 * Node-only (uses child_process); kept out of the pure engine on purpose.
 */
import { execFileSync, execSync } from "node:child_process";
import { bisectFirstFailing, type BisectResult, type CommitProbe } from "../engine/bisect.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** List commits in a range, oldest → newest (the order bisection expects). */
export function listCommits(cwd: string, range: string): string[] {
  const out = git(cwd, ["rev-list", "--reverse", range]);
  return out ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

/** The branch name if on one, otherwise the current commit SHA — used to restore. */
export function currentRef(cwd: string): string {
  try {
    const branch = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch) return branch;
  } catch {
    // detached HEAD — fall through to SHA
  }
  return git(cwd, ["rev-parse", "HEAD"]);
}

function assertCleanTree(cwd: string): void {
  const status = git(cwd, ["status", "--porcelain"]);
  if (status) {
    throw new Error("bisect: working tree is not clean — commit or stash changes before bisecting.");
  }
}

/**
 * A probe that checks out a commit and runs `command`; exit 0 means the lock
 * passes there. Does NOT restore — the caller restores once after the search.
 */
export function createShellProbe(opts: { cwd: string; command: string }): CommitProbe {
  return (commit: string) => {
    git(opts.cwd, ["checkout", "--quiet", commit]);
    try {
      execSync(opts.command, { cwd: opts.cwd, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
}

export interface GitBisectOptions {
  /** Working tree to bisect in. */
  cwd: string;
  /** Shell command run after each checkout; exit 0 = lock passes, non-zero = fails. */
  command: string;
  /** Explicit commit list, oldest → newest. If omitted, derived from `range`. */
  commits?: string[];
  /** e.g. "main~30..main". Used when `commits` is not provided. */
  range?: string;
}

/**
 * Run a real bisection over a git history. Restores the original ref afterwards,
 * even if a probe throws. Returns the engine's BisectResult.
 */
export async function runGitBisect(opts: GitBisectOptions): Promise<BisectResult> {
  const { cwd, command } = opts;
  assertCleanTree(cwd);

  const commits = opts.commits ?? (opts.range ? listCommits(cwd, opts.range) : []);
  if (commits.length === 0) {
    throw new Error("bisect: no commits to search (provide `commits` or a non-empty `range`).");
  }

  const origRef = currentRef(cwd);
  const probe = createShellProbe({ cwd, command });
  try {
    return await bisectFirstFailing(commits, probe);
  } finally {
    git(cwd, ["checkout", "--quiet", origRef]);
  }
}
