/**
 * `slipmark mcp`: a Model Context Protocol server on stdio, so any coding agent
 * that speaks MCP (Claude Code, Codex, Cursor, Copilot, Gemini CLI) can record
 * and check verdicts without shelling out.
 *
 * Two tools, run in the folder the server was started in (the repository root):
 *   - slipmark_attest: record a verdict bound to the SHA-256 of the files it covers
 *   - slipmark_verify: check every verdict against the files as they are now
 *
 * Deliberately narrower than the CLI. An agent can't record a `human` verdict
 * (that's how context changes are approved), can't run commands through the
 * server (`--run`), and can't sign. Hand-written JSON-RPC, no dependencies: it
 * is a few messages, and a security tool shouldn't pull in a framework for them.
 */
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import {
  createAttestation,
  writeAttestation,
  defaultAttestationPath,
  verifyWithSignatures,
  resolvePolicy,
  loadPolicy,
  POLICY_SCHEMA,
  type Policy,
  type VerifyReport,
  type Verdict,
} from "./attest/attestation.js";

const PROTOCOL_VERSION = "2025-06-18";
const VERDICTS = ["pass", "cleared", "fail", "blocked"] as const;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export const TOOLS = [
  {
    name: "slipmark_attest",
    title: "Record a verdict with Slipmark",
    description:
      "Record your verdict on files you reviewed, bound to the SHA-256 of each file as it is now. " +
      "Call it after every review, audit or approval. If any of the files change later, the verdict stops counting " +
      "and the CI gate refuses until it is re-checked. Use fail or blocked honestly: a verdict is a record, not a formality.",
    inputSchema: {
      type: "object",
      properties: {
        by: { type: "string", description: "Your role, for example security-reviewer or code-reviewer." },
        verdict: { type: "string", enum: [...VERDICTS], description: "pass or cleared if the files are fine, fail or blocked if not." },
        subjects: { type: "array", items: { type: "string" }, minItems: 1, description: "Repository-relative paths of every file the verdict covers. Only files you actually read." },
        against: { type: "array", items: { type: "string" }, description: "Files you checked them against, such as a spec or checklist." },
        note: { type: "string", description: "One or two sentences on what you checked." },
        model: { type: "string", description: "The model you are running as." },
        harness: { type: "string", description: "The tool you run in, for example codex, claude-code or cursor." },
        checks: {
          type: "array",
          description: "Checks you ran and their exit codes. A claim: a passing verdict with a non-zero check is refused.",
          items: { type: "object", properties: { command: { type: "string" }, exitCode: { type: "integer" } }, required: ["command", "exitCode"] },
        },
      },
      required: ["by", "verdict", "subjects"],
      additionalProperties: false,
    },
  },
  {
    name: "slipmark_verify",
    title: "Check verdicts with Slipmark",
    description:
      "Check every recorded verdict against the files as they are now. Reports verdicts about files that changed since, " +
      "agent instructions that changed since, and (with coverageBase) changed files no verdict covers. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        coverageBase: { type: "string", description: "Branch to compare with, for example origin/main. Every file changed since it then needs a current, passing verdict." },
        require: { type: "array", items: { type: "string" }, description: "Files that must have a current, passing verdict." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
] as const;

function strings(v: unknown, name: string, required = false): string[] {
  if (v === undefined && !required) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0) || (required && v.length === 0)) {
    throw new Error(`${name} must be a list of file paths`);
  }
  return v as string[];
}

function str(v: unknown, name: string, required = false): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} must be a non-empty string`);
  return v;
}

/** `slipmark_attest`. Same rules as `slipmark attest`, minus human, --run and --sign. */
export function attestTool(root: string, args: Record<string, unknown>): string {
  const by = str(args.by, "by", true)!;
  const verdict = str(args.verdict, "verdict", true)!;
  if (!(VERDICTS as readonly string[]).includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(", ")}`);
  const subjects = strings(args.subjects, "subjects", true);
  const checks = args.checks === undefined ? [] : (() => {
    if (!Array.isArray(args.checks)) throw new Error("checks must be a list");
    return args.checks.map((c) => {
      const o = c as { command?: unknown; exitCode?: unknown };
      if (typeof o?.command !== "string" || !o.command.trim() || !Number.isInteger(o.exitCode)) throw new Error("each check needs a command and an integer exitCode");
      return { command: o.command, exitCode: o.exitCode as number };
    });
  })();
  const model = str(args.model, "model") ?? process.env.SLIPMARK_MODEL ?? undefined;
  const harness = str(args.harness, "harness");
  // Record the agent's context when the policy checks it, as `slipmark attest` does for agents.
  let ctx: Policy["context"];
  try {
    ctx = loadPolicy(root)?.context;
  } catch {
    ctx = undefined; // verify reports a malformed policy; the verdict is still recorded
  }
  const att = createAttestation({
    root,
    by,
    verdict: verdict as Verdict,
    subjects,
    against: strings(args.against, "against"),
    note: str(args.note, "note"),
    checks,
    kind: "agent",
    agent: model || harness ? { model, harness } : undefined,
    context: ctx ? (ctx.files ?? true) : false,
  });
  const out = defaultAttestationPath(resolve(root, ".slipmark/attestations"), att);
  writeAttestation(out, att);
  const lines = [
    `Recorded: ${att.by} gave "${att.verdict}" on ${att.subjects.length} file(s).`,
    ...att.subjects.map((s) => `  ${s.sha256.slice(0, 12)}  ${s.path}`),
    ...(att.against ?? []).map((a) => `  ${a.sha256.slice(0, 12)}  ${a.path} (checked against)`),
    ...(att.context ? [`  agent context: ${att.context.length} file(s)`] : []),
    `Written to ${out.slice(resolve(root).length + 1)}. Commit it with the change.`,
  ];
  return lines.join("\n");
}

/** `slipmark_verify`. The report as text an agent can act on. */
export async function verifyTool(root: string, args: Record<string, unknown>): Promise<{ text: string; ok: boolean }> {
  const base = str(args.coverageBase, "coverageBase");
  if (base && (base.startsWith("-") || base === "HEAD")) throw new Error("coverageBase must be the branch you merge into, such as origin/main");
  const { policy: resolved, info } = resolvePolicy({ root, candidates: base ? [base] : [] });
  const policy: Policy | null = base
    ? { ...(resolved ?? { schema: POLICY_SCHEMA }), coverage: { mode: "diff", base, ignore: resolved?.coverage?.ignore } }
    : resolved;
  // No GitHub renderer here: an MCP server must not make network calls the user didn't ask for. CI runs it.
  const report: VerifyReport = await verifyWithSignatures({ root, require: strings(args.require, "require"), policy, policySource: info, render: null });
  const passed = report.results.filter((r) => r.status === "verified").length;
  const lines = [
    `Slipmark verify: ${passed} verified, ${report.failures.length} refused. ${report.ok ? "Every verdict matches the files as they are now." : "Gate refused."}`,
    ...report.results.map((r) => `${r.status === "verified" ? "ok" : "REFUSED"} ${r.status}: ${r.message}`),
    ...(report.notes ?? []).map((n) => `note: ${n}`),
  ];
  if (!report.ok && report.checked === 0) lines.push("No verdicts recorded yet. Record one with slipmark_attest after reviewing.");
  else if (!report.ok) lines.push("Re-read the files that changed and record a new verdict with slipmark_attest. A changed AGENTS.md, CLAUDE.md, skill or MCP config needs a person's approval, not yours: tell the user.");
  return { text: lines.join("\n"), ok: report.ok };
}

/** Handles one JSON-RPC message. Returns the response, or null for notifications. */
export async function handle(msg: JsonRpcRequest, root: string, version: string): Promise<object | null> {
  const reply = (result: object) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null; // notifications (initialized, cancelled): nothing to send
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "slipmark", title: "Slipmark", version },
        instructions:
          "Slipmark binds every verdict you give to the SHA-256 of the files you read. After any review or approval, call slipmark_attest with the files you read. Before finishing, call slipmark_verify.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        if (name === "slipmark_attest") return reply({ content: [{ type: "text", text: attestTool(root, args) }] });
        if (name === "slipmark_verify") {
          // A refusal is a result, not a tool failure: the text says what to do.
          const { text } = await verifyTool(root, args);
          return reply({ content: [{ type: "text", text }] });
        }
        return error(-32602, `unknown tool: ${String(name)}`);
      } catch (e) {
        // A tool error the agent can read and fix, not a protocol error.
        return reply({ content: [{ type: "text", text: `slipmark: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
      }
    }
    default:
      return error(-32601, `method not found: ${msg.method}`);
  }
}

/** Runs the server on stdin/stdout until stdin closes. Logs go to stderr only. */
export async function serveMcp(root: string, version: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      continue;
    }
    const res = await handle(msg, root, version);
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  }
}
