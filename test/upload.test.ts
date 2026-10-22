import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttestation, writeAttestation, defaultAttestationPath } from "../src/attest/attestation.js";
import { uploadRun, getOidcToken, collectAttestations, summaryMarkdown, OIDC_AUDIENCE } from "../src/cloud/upload.js";

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };

function fakeFetch(ingest: { status: number; body: unknown }) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: Call["init"]) => {
    calls.push({ url, init });
    if (url.startsWith("https://token.example/")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ value: "oidc.jwt.token" }) };
    }
    return { ok: ingest.status < 300, status: ingest.status, text: async () => JSON.stringify(ingest.body) };
  };
  return { impl, calls };
}

const ACTIONS_ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/token?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

function repo() {
  const root = mkdtempSync(join(tmpdir(), "sm-up-"));
  mkdirSync(join(root, "specs"));
  writeFileSync(join(root, "specs/a.md"), "# A\n");
  const att = createAttestation({ root, subjects: ["specs/a.md"], verdict: "pass", by: "reviewer" });
  writeAttestation(defaultAttestationPath(join(root, ".slipmark/attestations"), att), att);
  return root;
}

test("upload: no OIDC token outside Actions, and nothing is sent", async () => {
  const { impl, calls } = fakeFetch({ status: 201, body: {} });
  const r = await uploadRun({ root: repo(), clientVersion: "0.4.0", env: {}, fetchImpl: impl });
  assert.equal(r.ok, false);
  assert.match(r.message, /id-token: write/);
  assert.equal(calls.length, 0);
});

test("upload: requests the token with the slipmark audience and the runtime's bearer", async () => {
  const { impl, calls } = fakeFetch({ status: 201, body: {} });
  const token = await getOidcToken(ACTIONS_ENV, impl);
  assert.equal(token, "oidc.jwt.token");
  assert.equal(calls[0]!.url, `https://token.example/token?api-version=2.0&audience=${OIDC_AUDIENCE}`);
  assert.equal(calls[0]!.init!.headers!.authorization, "bearer request-token");
});

test("upload: posts the report and attestations with the OIDC token, and returns the proof link", async () => {
  const { impl, calls } = fakeFetch({
    status: 201,
    body: { run_id: "r1", seq: 7, entry_hash: "ab".repeat(32), url: "https://app.slipmark.dev/r/o/r/runs/r1" },
  });
  const r = await uploadRun({ root: repo(), clientVersion: "0.4.0", env: ACTIONS_ENV, fetchImpl: impl, url: "https://cloud.example/ingest" });
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://app.slipmark.dev/r/o/r/runs/r1");
  assert.equal(r.seq, 7);
  const post = calls[1]!;
  assert.equal(post.url, "https://cloud.example/ingest");
  assert.equal(post.init!.headers!.authorization, "Bearer oidc.jwt.token");
  const body = JSON.parse(post.init!.body!);
  assert.equal(body.report.ok, true);
  assert.equal(body.attestations.length, 1);
  assert.equal(body.attestations[0].file, ".slipmark/attestations/reviewer--specs_a.md.json");
  assert.equal(body.client_version, "0.4.0");
});

test("upload: a refusal from Cloud is reported, not thrown", async () => {
  const { impl } = fakeFetch({ status: 401, body: { error: "invalid OIDC token" } });
  const r = await uploadRun({ root: repo(), clientVersion: "0.4.0", env: ACTIONS_ENV, fetchImpl: impl });
  assert.equal(r.ok, false);
  assert.match(r.message, /401.*invalid OIDC token/);
});

test("upload: collectAttestations skips files that are not JSON", () => {
  const root = repo();
  writeFileSync(join(root, ".slipmark/attestations/broken.json"), "{ nope");
  assert.equal(collectAttestations(root, ".slipmark/attestations").length, 1);
});

test("upload: job summary links the proof record", () => {
  const md = summaryMarkdown(
    { ok: true, checked: 1, results: [{ status: "verified", message: "" }], failures: [] },
    { ok: true, status: 201, url: "https://app.slipmark.dev/r/o/r/runs/r1", seq: 3, entryHash: "cd".repeat(32), message: "" },
  );
  assert.match(md, /every verdict matches/);
  assert.match(md, /\[Proof record #3\]\(https:\/\/app\.slipmark\.dev\/r\/o\/r\/runs\/r1\)/);
});
