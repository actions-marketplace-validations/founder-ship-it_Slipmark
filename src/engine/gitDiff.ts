/**
 * Git context normalisation + diff keyword matching (domain-agnostic).
 */
import type { ChangedFile, GitContext } from "../types.js";

export function normaliseGitContext(git: GitContext | null | undefined): Required<
  Pick<GitContext, "changedFiles">
> &
  GitContext {
  const g = git || {};
  return {
    changedFiles: Array.isArray(g.changedFiles) ? g.changedFiles : [],
    diffSummary: g.diffSummary ?? null,
    currentCommit: g.currentCommit ?? null,
    lastPassingCommit: g.lastPassingCommit ?? null,
    executionTrace: g.executionTrace ?? null,
  };
}

export function describeDiffAvailability(git: GitContext): {
  available: boolean;
  reason: string;
  changedFilesCount: number;
  hasDiffSummary: boolean;
} {
  const changed = git.changedFiles || [];
  const available = changed.length > 0;
  return {
    available,
    reason: available ? "git diff present" : "no changed files supplied",
    changedFilesCount: changed.length,
    hasDiffSummary: Boolean(git.diffSummary && String(git.diffSummary).trim().length > 0),
  };
}

/** Match a body of text against a pack-supplied keyword set. Case-insensitive, whole-ish word. */
export function matchDiffKeywords(text: string, keywords: string[]): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const hits = new Set<string>();
  for (const kw of keywords) {
    const k = kw.toLowerCase().trim();
    if (!k) continue;
    if (lower.includes(k)) hits.add(kw);
  }
  return Array.from(hits);
}

export function changedFilePaths(files: ChangedFile[]): string[] {
  return files.map((f) => f.path);
}
