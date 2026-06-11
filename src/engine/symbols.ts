/**
 * Lightweight changed-symbol extraction (semantic-ish diff signal).
 *
 * Pulls function / const / class / method names out of a diff excerpt. A change
 * to a symbol a lock *watches* is "earned" evidence — far stronger than the
 * file merely being near the failure. Deliberately language-agnostic and
 * dependency-free: it recognises common declaration shapes, not a full AST.
 */
const DECL_PATTERNS: RegExp[] = [
  /\bfunction\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /\bclass\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:\{|=>|:)/g, // method / arrow-ish
  /\bdef\s+([A-Za-z_$][\w$]*)/g, // python
];

const NOISE = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "const",
  "let",
  "var",
  "class",
  "async",
  "await",
  "export",
  "import",
]);

/** Extract candidate symbol names declared or defined in a diff excerpt. */
export function extractChangedSymbols(excerpt: string): string[] {
  if (!excerpt) return [];
  const found = new Set<string>();
  for (const re of DECL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(excerpt)) !== null) {
      const name = m[1];
      if (name && !NOISE.has(name)) found.add(name);
    }
  }
  return Array.from(found);
}

/** Intersection of a lock's watched symbols with the symbols changed in a diff. */
export function changedWatchedSymbols(
  watched: string[] | undefined,
  changedSymbols: string[],
): string[] {
  if (!watched || watched.length === 0 || changedSymbols.length === 0) return [];
  const changed = new Set(changedSymbols);
  return watched.filter((w) => changed.has(w));
}
