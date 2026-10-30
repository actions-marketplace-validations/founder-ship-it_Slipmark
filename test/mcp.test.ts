import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { handle } from "../src/mcp.js";

const CLI = resolve("dist/src/cli.js");

function repo(policy?: object) {
  const root = mkdtempSync(join(tmpdir(), "sm-mcp-"));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "AGENTS.md"), "# Agent instructions\n");
  if (policy) {
    mkdirSync(join(root, ".slipmark"), { recursive: true });
    writeFileSync(join(root, ".slipmark/policy.json"), JSON.stringify(policy));
  }
  return root;
}

async function connect(root: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: root, stderr: "pipe" }));
  return client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

test("mcp: an MCP client sees both tools", async () => {
  const client = await connect(repo());
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["slipmark_attest", "slipmark_verify"]);
  } finally {
    await client.close();
  }
});

test("mcp: attest then verify, then a change is refused", async () => {
  const root = repo();
  const client = await connect(root);
  try {
    const a = await client.callTool({ name: "slipmark_attest", arguments: { by: "codex-reviewer", verdict: "pass", subjects: ["src/a.ts"], harness: "codex" } });
    assert.match(text(a), /codex-reviewer gave "pass" on 1 file/);
    const files = readdirSync(join(root, ".slipmark/attestations"));
    assert.equal(files.length, 1);
    const att = JSON.parse(readFileSync(join(root, ".slipmark/attestations", files[0]!), "utf8"));
    assert.equal(att.kind, "agent");
    assert.equal(att.agent.harness, "codex");

    assert.match(text(await client.callTool({ name: "slipmark_verify", arguments: {} })), /1 verified, 0 refused/);
    writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
    const v = text(await client.callTool({ name: "slipmark_verify", arguments: {} }));
    assert.match(v, /REFUSED hash_mismatch/);
  } finally {
    await client.close();
  }
});

test("mcp: with a context policy, verdicts record the agent's instructions and lapse when they change", async () => {
  const root = repo({ schema: "slipmark/policy@1", context: {} });
  const client = await connect(root);
  try {
    assert.match(text(await client.callTool({ name: "slipmark_attest", arguments: { by: "r", verdict: "pass", subjects: ["src/a.ts"] } })), /agent context: 1 file/);
    writeFileSync(join(root, "AGENTS.md"), "# Agent instructions\n- new rule\n");
    const v = text(await client.callTool({ name: "slipmark_verify", arguments: {} }));
    assert.match(v, /context_changed/);
    assert.match(v, /needs a person's approval/);
  } finally {
    await client.close();
  }
});

test("mcp: an agent can't record a human approval or run commands", async () => {
  const root = repo();
  const r = (await handle(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slipmark_attest", arguments: { by: "x", verdict: "pass", subjects: ["src/a.ts"], kind: "human" } } },
    root,
    "test",
  )) as { result: { content: { text: string }[] } };
  // Unknown fields are ignored by the tool, and the verdict is recorded as an agent's.
  const files = readdirSync(join(root, ".slipmark/attestations"));
  const att = JSON.parse(readFileSync(join(root, ".slipmark/attestations", files[0]!), "utf8"));
  assert.equal(att.kind, "agent");
  assert.ok(r.result.content[0]!.text.includes("Recorded"));
});

test("mcp: bad input comes back as a readable tool error, not a crash", async () => {
  const root = repo();
  const bad = async (args: object) =>
    ((await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slipmark_attest", arguments: args } }, root, "t")) as {
      result: { isError?: boolean; content: { text: string }[] };
    }).result;
  assert.equal((await bad({ by: "x", verdict: "maybe", subjects: ["src/a.ts"] })).isError, true);
  assert.equal((await bad({ by: "x", verdict: "pass", subjects: [] })).isError, true);
  assert.equal((await bad({ by: "x", verdict: "pass", subjects: ["../outside.ts"] })).isError, true);
  const v = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slipmark_verify", arguments: { coverageBase: "--evil" } } }, root, "t")) as {
    result: { isError?: boolean };
  };
  assert.equal(v.result.isError, true);
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, root, "t"), null);
});
