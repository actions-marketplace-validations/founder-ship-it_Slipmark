/**
 * Bisection — "git-bisect for AI behavior".
 *
 * Given an ordered commit history (oldest → newest) and a probe that answers
 * "does the lock PASS at this commit?", binary-search for the first commit where
 * the behavior flipped from pass to fail. This is the causal evidence that turns
 * "a file near here changed" into "THIS commit introduced the regression".
 *
 * The algorithm is pure: the host supplies the probe (which, in a real repo,
 * checks out the commit and re-runs the pack). See BisectRunner for the adapter
 * the CLI / CI wires up.
 */
export type CommitProbe = (commit: string) => boolean | Promise<boolean>;

export interface BisectResult {
  /** First commit (in history order) at which the lock fails. Null if none fail. */
  firstFailingCommit: string | null;
  /** Last commit before the failure (the known-good baseline). Null if the first commit already fails. */
  lastPassingCommit: string | null;
  /** Probe results gathered during the search, in evaluation order. */
  steps: { commit: string; passed: boolean }[];
  /** Number of probes evaluated (binary search → ~log2(n)). */
  evaluated: number;
}

/**
 * Binary-search the pass→fail boundary. Assumes the behavior is monotonic over
 * the history (some prefix passes, the rest fails) — the standard bisection
 * assumption. With n commits this evaluates ~log2(n) probes, not n.
 */
export async function bisectFirstFailing(
  commits: string[],
  isPassingAt: CommitProbe,
): Promise<BisectResult> {
  const steps: { commit: string; passed: boolean }[] = [];
  const cache = new Map<string, boolean>();

  async function probe(commit: string): Promise<boolean> {
    if (cache.has(commit)) return cache.get(commit)!;
    const passed = await isPassingAt(commit);
    cache.set(commit, passed);
    steps.push({ commit, passed });
    return passed;
  }

  if (commits.length === 0) {
    return { firstFailingCommit: null, lastPassingCommit: null, steps, evaluated: 0 };
  }

  // If the newest commit still passes, there is no regression in this range.
  if (await probe(commits[commits.length - 1]!)) {
    return { firstFailingCommit: null, lastPassingCommit: commits[commits.length - 1]!, steps, evaluated: steps.length };
  }
  // If the oldest commit already fails, the regression predates this range.
  if (!(await probe(commits[0]!))) {
    return { firstFailingCommit: commits[0]!, lastPassingCommit: null, steps, evaluated: steps.length };
  }

  // Invariant: commits[lo] passes, commits[hi] fails. Find the boundary.
  let lo = 0;
  let hi = commits.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (await probe(commits[mid]!)) lo = mid;
    else hi = mid;
  }

  return {
    firstFailingCommit: commits[hi]!,
    lastPassingCommit: commits[lo]!,
    steps,
    evaluated: steps.length,
  };
}

/**
 * Adapter the host implements to make bisection real: check out a commit and
 * report whether the lock passes there. The engine never shells out itself —
 * the host owns the working tree.
 *
 * Example (pseudo):
 *   const runner: BisectRunner = {
 *     async isPassingAt(commit) {
 *       await git(`checkout ${commit}`);
 *       const run = runPack(pack);
 *       return run.outcomes.find(o => o.key === lockKey)?.result.status === "pass";
 *     }
 *   };
 */
export interface BisectRunner {
  isPassingAt: CommitProbe;
}
