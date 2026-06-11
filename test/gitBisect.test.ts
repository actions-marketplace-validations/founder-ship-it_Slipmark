import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitBisect, listCommits, currentRef } from "../src/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("git bisect adapter: finds the real culprit commit and restores the working tree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dg-bisect-"));
  try {
    git(dir, "init", "--quiet");
    git(dir, "config", "user.email", "t@t.dev");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "commit.gpgsign", "false");

    // History: behavior "latest" (good) for 3 commits, then "first" (the bug) for 3.
    const shas: string[] = [];
    const states = ["latest", "latest", "latest", "first", "first", "first"];
    for (let i = 0; i < states.length; i++) {
      // Include a per-commit marker so consecutive same-behavior commits still differ.
      writeFileSync(join(dir, "behavior.txt"), `${states[i]}\n# commit ${i}\n`);
      git(dir, "add", "behavior.txt");
      git(dir, "commit", "--quiet", "-m", `c${i}: ${states[i]}`);
      shas.push(git(dir, "rev-parse", "HEAD"));
    }

    const commits = listCommits(dir, "HEAD"); // oldest → newest
    assert.equal(commits.length, 6);

    const refBefore = currentRef(dir);

    // Probe: exit 0 (pass) only while behavior is still "latest".
    const result = await runGitBisect({
      cwd: dir,
      command: "grep -q latest behavior.txt",
      commits,
    });

    // c3 (index 3) is the first commit where behavior became "first".
    assert.equal(result.firstFailingCommit, shas[3]);
    assert.equal(result.lastPassingCommit, shas[2]);
    assert.ok(result.evaluated <= 5, `expected ~log2(6) probes, got ${result.evaluated}`);

    // Working tree was restored: back on the original ref, HEAD content intact.
    assert.equal(currentRef(dir), refBefore);
    assert.match(readFileSync(join(dir, "behavior.txt"), "utf8"), /first/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
