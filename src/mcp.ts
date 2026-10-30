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
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import {
  createAttestation,
  verifyWithSignatures,
  resolvePolicy,
  loadPolicy,
  POLICY_SCHEMA,
  type Policy,
  type VerifyReport,
  type Verdict,
} from "./attest/attestation.js";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
/** Longest message line accepted. Tool calls are small; anything bigger is refused, not buffered. */
const MAX_LINE = 1024 * 1024;
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

/**
 * Writes a new attestation file and never touches an existing one. The name is
 * the tool's own (`mcp--<by>--<hash>.json`), so an agent can't overwrite a
 * person's approval or another reviewer's fail by choosing their name, and the
 * file is created exclusively, so a link planted at that name (or a linked
 * .slipmark folder) can't redirect the write outside the repository.
 */
function writeNew(root: string, att: object & { by: string }): string {
  const realRoot = realpathSync(root);
  let dir = realRoot;
  for (const part of [".slipmark", "attestations"]) {
    dir = join(dir, part);
    if (existsSync(dir) || isLink(dir)) {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir.slice(realRoot.length + 1)} must be a real folder, not a link or a file`);
    } else {
      mkdirSync(dir);
    }
  }
  const body = JSON.stringify(att, null, 2) + "\n";
  const slug = att.by.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 40) || "agent";
  const file = join(dir, `mcp--${slug}--${createHash("sha256").update(body).digest("hex").slice(0, 16)}.json`);
  writeFileSync(file, body, { encoding: "utf8", flag: "wx" }); // O_CREAT|O_EXCL: fails on any existing path, links included
  return file.slice(realRoot.length + 1);
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when `base` names the commit we're on: coverage against it covers nothing. */
function sameAsHead(root: string, base: string): boolean {
  const rev = (ref: string) => execFileSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let b: string;
  try {
    b = rev(base);
  } catch {
    throw new Error(`coverageBase ${base} isn't in this checkout. Fetch it first, for example git fetch origin main`);
  }
  try {
    return b === rev("HEAD");
  } catch {
    return false;
  }
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
  // Always record the agent's context. Whether a policy checks it is decided by
  // the base branch's policy in CI, which this branch can't see or change.
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
    context: ctx?.files ?? true,
  });
  const out = writeNew(root, att);
  const lines = [
    `Recorded: ${att.by} gave "${att.verdict}" on ${att.subjects.length} file(s).`,
    ...att.subjects.map((s) => `  ${s.sha256.slice(0, 12)}  ${s.path}`),
    ...(att.against ?? []).map((a) => `  ${a.sha256.slice(0, 12)}  ${a.path} (checked against)`),
    ...(att.context ? [`  agent context: ${att.context.length} file(s)`] : []),
    `Written to ${out}. Commit it with the change.`,
  ];
  return lines.join("\n");
}

/** `slipmark_verify`. The report as text an agent can act on. */
export async function verifyTool(root: string, args: Record<string, unknown>): Promise<{ text: string; ok: boolean }> {
  const base = str(args.coverageBase, "coverageBase");
  if (base && (base.startsWith("-") || /\s/.test(base) || sameAsHead(root, base))) {
    throw new Error("coverageBase must be the branch you merge into, such as origin/main, not the branch you're on");
  }
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
export async function handle(raw: unknown, root: string, version: string): Promise<object | null> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || typeof (raw as { method?: unknown }).method !== "string") {
    // Batches aren't part of MCP since 2025-06-18; anything that isn't one request object gets a plain error.
    const id = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? ((raw as { id?: string | number | null }).id ?? null) : null;
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request: expected one JSON-RPC request object" } };
  }
  const msg = raw as JsonRpcRequest;
  const reply = (result: object) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null; // notifications (initialized, cancelled): nothing to send
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(String(msg.params?.protocolVersion)) ? String(msg.params?.protocolVersion) : PROTOCOL_VERSIONS[0],
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
  process.stdout.on("error", () => process.exit(0)); // the client went away
  const send = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (line.length > MAX_LINE) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request too large" } });
      continue;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    try {
      const res = await handle(msg, root, version);
      if (res) send(res);
    } catch (e) {
      const id = typeof msg === "object" && msg !== null ? ((msg as { id?: unknown }).id ?? null) : null;
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    }
  }
}

/**
 * The folder to serve: --root, then SLIPMARK_ROOT, then the current folder.
 * Inside a git repository it must be the top of it, where agents read their
 * instructions and CI checks verdicts.
 */
export function mcpRoot(args: string[], env: NodeJS.ProcessEnv, cwd: string): string {
  const i = args.indexOf("--root");
  const given = i >= 0 ? args[i + 1] : env.SLIPMARK_ROOT;
  if (i >= 0 && (!given || given.startsWith("--"))) throw new Error("--root needs a folder");
  const root = resolve(cwd, given || ".");
  if (!existsSync(root)) throw new Error(`${root} doesn't exist`);
  let top: string | null = null;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    top = null; // not a git repository: the folder is the whole tree
  }
  if (top && realpathSync(top) !== realpathSync(root)) {
    throw new Error(`run it from the repository root (${top}), not ${root}. Pass --root ${top}, or set your client's working folder`);
  }
  return root;
}
