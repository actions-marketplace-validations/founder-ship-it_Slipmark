import { readFileSync } from "node:fs";
import { staleVerdictsDecision, type StopHookInput } from "./staleVerdicts.js";

let input: StopHookInput = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}") as StopHookInput;
} catch {
  /* no stdin */
}
const out = staleVerdictsDecision(input, process.cwd());
if (out) process.stdout.write(out);
process.exit(0);
