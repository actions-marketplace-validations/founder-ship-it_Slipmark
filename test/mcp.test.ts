import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { handle, mcpRoot } from "../src/mcp.js";
import { createAttestation, writeAttestation, defaultAttestationPath } from "../src/attest/attestation.js";

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

const call = async (root: string, name: string, args: object) =>
  ((await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, root, "t")) as {
    result: { isError?: boolean; content: { text: string }[] };
  }).result;

test("mcp: never overwrites an existing verdict, a person's approval included", async () => {
  const root = repo();
  const human = createAttestation({ root, subjects: ["src/a.ts"], verdict: "pass", by: "alice", kind: "human" });
  const humanFile = defaultAttestationPath(join(root, ".slipmark/attestations"), human);
  writeAttestation(humanFile, human);
  const r = await call(root, "slipmark_attest", { by: "alice", verdict: "fail", subjects: ["src/a.ts"] });
  assert.ok(!r.isError);
  assert.equal(JSON.parse(readFileSync(humanFile, "utf8")).kind, "human", "the person's verdict is untouched");
  assert.equal(readdirSync(join(root, ".slipmark/attestations")).length, 2);
});

test("mcp: a linked attestations folder can't redirect the write outside the repo", async () => {
  const root = repo();
  const outside = mkdtempSync(join(tmpdir(), "sm-mcp-out-"));
  mkdirSync(join(root, ".slipmark"), { recursive: true });
  symlinkSync(outside, join(root, ".slipmark/attestations"));
  const r = await call(root, "slipmark_attest", { by: "r", verdict: "pass", subjects: ["src/a.ts"] });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /must be a real folder/);
  assert.equal(readdirSync(outside).length, 0);
});

test("mcp: messages that aren't one request object get an error, not a crash", async () => {
  const root = repo();
  for (const bad of [null, 5, "x", [{ jsonrpc: "2.0", id: 1, method: "ping" }], { jsonrpc: "2.0", id: 3 }]) {
    const r = (await handle(bad, root, "t")) as { error: { code: number } };
    assert.equal(r.error.code, -32600);
  }
});

test("mcp: echoes a protocol version it supports", async () => {
  const r = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, repo(), "t")) as {
    result: { protocolVersion: string };
  };
  assert.equal(r.result.protocolVersion, "2025-03-26");
});

test("mcp: coverageBase can't be the commit you're on", async () => {
  const root = repo();
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"]);
  const r = await call(root, "slipmark_verify", { coverageBase: "HEAD~0" });
  assert.equal(r.isError, true);
});

test("mcp: refuses to serve a subfolder of a repository", () => {
  const root = repo();
  assert.throws(() => mcpRoot([], {}, join(root, "src")), /repository root/);
  assert.equal(mcpRoot(["--root", root], {}, "/"), root);
  assert.equal(existsSync(mcpRoot([], { SLIPMARK_ROOT: root }, "/")), true);
});

test("mcp: server.json matches package.json, so the MCP Registry accepts it", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const server = JSON.parse(readFileSync("server.json", "utf8"));
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  const npm = server.packages.find((p: { registryType: string }) => p.registryType === "npm");
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.ok(server.description.length <= 100);
});
