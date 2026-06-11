/**
 * File / module relevance scoring (domain-agnostic).
 *
 * Scores are heuristic (0..1) and advisory. The signature->module map is supplied
 * by the Pack, NOT hardcoded in the engine.
 */
import type {
  ChangedFile,
  FailureSignatureMatch,
  LockDefinition,
  RankedFile,
  RankedModule,
} from "../types.js";
import { matchDiffKeywords } from "./gitDiff.js";

/** Convert a minimal glob ("a/b/**", "a/b/*.ts", "a/b/c.ts") into a RegExp anchored at the start. */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp("^" + escaped + "$");
}

function fileMatchesAnyGlob(
  path: string,
  patterns: string[] | undefined,
): { matched: boolean; matchedPattern: string | null } {
  if (!patterns || patterns.length === 0) return { matched: false, matchedPattern: null };
  for (const p of patterns) {
    try {
      if (globToRegex(p).test(path)) return { matched: true, matchedPattern: p };
    } catch {
      // ignore malformed globs
    }
  }
  return { matched: false, matchedPattern: null };
}

function moduleHitInPath(path: string, modules: string[] | undefined): string | null {
  if (!modules || modules.length === 0) return null;
  const lower = path.toLowerCase();
  for (const m of modules) {
    const token = String(m).toLowerCase().replace(/_/g, "");
    if (!token) continue;
    if (lower.replace(/[^a-z0-9]/g, "").includes(token)) return m;
  }
  return null;
}

/**
 * Rank changed files by relevance. ONLY produces a ranking when real changedFiles
 * evidence was provided — never fabricates a ranking from nothing.
 */
export function rankChangedFilesForLock(
  lock: LockDefinition,
  changedFiles: ChangedFile[],
  matches: FailureSignatureMatch[],
  diffKeywords: string[],
  diffSummary: string | null = null,
): { ranked: RankedFile[]; source: "git" | "inferred" } {
  if (changedFiles.length === 0) return { ranked: [], source: "inferred" };

  const topSig = matches[0];
  const ranked: RankedFile[] = [];

  for (const f of changedFiles) {
    const glob = fileMatchesAnyGlob(f.path, lock.likelyFiles);
    const moduleHit = moduleHitInPath(f.path, lock.likelyModules);
    const excerptText = `${f.path} ${f.diffExcerpt || ""} ${diffSummary || ""}`;
    const keywordHits = matchDiffKeywords(excerptText, diffKeywords);

    if (!glob.matched && !moduleHit && keywordHits.length === 0) continue;

    let score = 0;
    const reasons: string[] = [];

    if (glob.matched) {
      score += 0.45;
      reasons.push(`matches lock ownership glob \`${glob.matchedPattern}\``);
    }
    if (moduleHit) {
      score += 0.2;
      reasons.push(`file path references module \`${moduleHit}\``);
    }
    if (topSig) {
      const bump = Math.min(0.2, topSig.score * 0.22);
      score += bump;
      reasons.push(`aligns with top signature \`${topSig.key}\``);
    }
    const churn = (f.additions || 0) + (f.deletions || 0);
    if (churn > 0) {
      const churnBoost = Math.min(0.08, Math.log10(churn + 1) / 20);
      score += churnBoost;
      reasons.push(`touched (${churn} line changes)`);
    }
    if (keywordHits.length > 0) {
      const kwBoost = Math.min(0.15, keywordHits.length * 0.04);
      score += kwBoost;
      reasons.push(`diff keyword match: ${keywordHits.map((k) => `\`${k}\``).join(", ")}`);
    }

    ranked.push({ path: f.path, score: Math.min(score, 0.98), reason: reasons.join("; ") });
  }

  ranked.sort((a, b) => b.score - a.score);
  return { ranked: ranked.slice(0, 10), source: "git" };
}

/**
 * Rank modules by combining lock-declared modules with the pack's signature->module
 * map and overlap with changed file paths.
 */
export function rankModulesForLock(
  lock: LockDefinition,
  matches: FailureSignatureMatch[],
  changedFiles: ChangedFile[],
  signatureToModules: Record<string, string[]>,
): RankedModule[] {
  const byName = new Map<string, RankedModule>();
  const declared = lock.likelyModules || [];

  for (const m of declared) {
    byName.set(m, { name: m, score: 0.4, reason: "declared in lock ownership" });
  }

  for (const f of changedFiles) {
    const hit = moduleHitInPath(f.path, declared);
    if (hit) {
      const existing = byName.get(hit);
      if (existing) {
        existing.score = Math.min(existing.score + 0.25, 0.95);
        existing.reason = `${existing.reason}; referenced by changed file \`${f.path}\``;
      }
    }
  }

  for (const m of matches) {
    const bumps = signatureToModules[m.key] || [];
    for (const name of bumps) {
      const existing = byName.get(name);
      if (existing) {
        existing.score = Math.min(existing.score + 0.15, 0.95);
        existing.reason = `${existing.reason}; signature \`${m.key}\` points here`;
      } else {
        byName.set(name, {
          name,
          score: 0.45,
          reason: `probable: signature \`${m.key}\` typically implicates this module`,
        });
      }
    }
  }

  const ranked = Array.from(byName.values());
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, 8);
}
