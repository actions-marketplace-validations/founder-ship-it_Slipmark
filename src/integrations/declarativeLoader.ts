/**
 * Node loader for declarative (JSON) packs.
 *
 * Reads a `*.json` pack file and compiles it into a runtime Pack, supplying a
 * child_process-based target runner: target commands are run with the fixture on
 * stdin and their stdout becomes the output to assert on. Commands run with the
 * pack file's directory as cwd, so a pack can ship its own thin target script.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compileDeclarativePack, type DeclarativePack, type DeclarativeTarget, type RunTarget } from "../authoring/declarative.js";
import type { Pack } from "../types.js";

function makeNodeRunTarget(packDir: string): RunTarget {
  return (target: DeclarativeTarget | undefined, fixture: unknown): string => {
    // Golden mode: no command → the fixture itself is the output to assert on.
    if (!target || !target.command) {
      return typeof fixture === "string" ? fixture : JSON.stringify(fixture ?? "");
    }
    const inputFormat = target.inputFormat || "stdin-json";
    const input = inputFormat === "stdin-text" ? String(fixture ?? "") : JSON.stringify(fixture ?? null);

    const res = spawnSync(target.command, {
      cwd: packDir,
      input,
      shell: true,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (res.error) throw res.error;
    if (typeof res.status === "number" && res.status !== 0) {
      throw new Error(`target command exited ${res.status}: ${(res.stderr || "").trim().slice(0, 300)}`);
    }
    return res.stdout ?? "";
  };
}

/** Load and compile a declarative pack from a JSON file path. */
export function loadDeclarativePack(filePath: string): Pack {
  const abs = resolve(filePath);
  let decl: DeclarativePack;
  try {
    decl = JSON.parse(readFileSync(abs, "utf8")) as DeclarativePack;
  } catch (e) {
    throw new Error(`could not read/parse declarative pack ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return compileDeclarativePack(decl, makeNodeRunTarget(dirname(abs)));
}
