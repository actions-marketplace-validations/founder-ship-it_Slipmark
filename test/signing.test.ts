import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttestation, writeAttestation, verifyAttestations, verifyWithSignatures, loadPolicy, POLICY_SCHEMA, type Attestation, type Policy } from "../src/attest/attestation.js";
import { canonicalJson, signedPayload, identityMatches, bundleIdentity, checkSignature, PAYLOAD_TYPE, type SigstoreBundle } from "../src/attest/signing.js";

// A self-signed test certificate whose identity is a GitHub Actions workflow, like a Fulcio one.
const CERT = "MIIB3zCCAYagAwIBAgIUSPpWcekJELfhZH8iwkTATDkRd6cwCgYIKoZIzj0EAwIwFzEVMBMGA1UECgwMc2lnc3RvcmUuZGV2MB4XDTI2MTAyMzExNDgxOFoXDTM2MTAyMDExNDgxOFowFzEVMBMGA1UECgwMc2lnc3RvcmUuZGV2MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEctevYiqooE/4lI3dsRVR+L1Bi08svreWTmW9UG/LKGx7owo1wFlC50vsKnt7+gh0aYjAkwTir/RN2b4VeTAWiqOBrzCBrDAdBgNVHQ4EFgQUsEyxTSpdrOqZkLAsZXrjzZATpYcwHwYDVR0jBBgwFoAUsEyxTSpdrOqZkLAsZXrjzZATpYcwDwYDVR0TAQH/BAUwAwEB/zBZBgNVHREEUjBQhk5odHRwczovL2dpdGh1Yi5jb20vYWNtZS9hcGkvLmdpdGh1Yi93b3JrZmxvd3MvYWdlbnQtcmV2aWV3LnltbEByZWZzL2hlYWRzL21haW4wCgYIKoZIzj0EAwIDRwAwRAIgeyDaMlv9QSLmSS9MhtFHYrl4LtUVV2iHlrAEb4PQDvgCIB6T2m7z3cGDui1u9scVyj2L1e0Oo6zA+JtAd1R2gIj0";
const WORKFLOW = "https://github.com/acme/api/.github/workflows/agent-review.yml@refs/heads/main";
const DIR = ".slipmark/attestations";
const ok = async () => undefined;
const bad = async () => { throw new Error("signature verification failed: bad signature"); };
const offline = async () => { const e = new Error("getaddrinfo ENOTFOUND tuf-repo-cdn.sigstore.dev"); e.name = "TUFError"; throw e; };

function repo() {
  const root = mkdtempSync(join(tmpdir(), "sm-sign-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/pay.ts"), "export const fee = 2;\n");
  return root;
}

/** Sign the way sigstore.attest does: a DSSE envelope over the canonical attestation. Only the signature bytes are fake. */
function fakeSign(att: Attestation, payload = signedPayload(att)): Attestation {
  const bundle: SigstoreBundle = {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { certificate: { rawBytes: CERT } },
    dsseEnvelope: { payload: payload.toString("base64"), payloadType: PAYLOAD_TYPE, signatures: [{ sig: "c2ln" }] },
  };
  return { ...att, signature: { bundle } };
}

function attest(root: string, signed: boolean, file = "security-reviewer.json") {
  let att = createAttestation({ root, by: "security-reviewer", verdict: "pass", subjects: ["src/pay.ts"], now: new Date("2026-10-23T10:00:00Z") });
  if (signed) att = fakeSign(att);
  writeAttestation(join(root, DIR, file), att);
  return att;
}

const policy = (sig: Policy["signatures"]): Policy => ({ schema: POLICY_SCHEMA, signatures: sig });

test("canonical JSON sorts keys at every level and drops undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } }), '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
});

test("the signed payload leaves out the signature itself", () => {
  const a = { schema: "x", by: "a", signature: { bundle: {} } };
  assert.equal(signedPayload(a).toString(), '{"by":"a","schema":"x"}');
});

test("signer patterns: * matches anything, everything else is literal", () => {
  assert.ok(identityMatches(WORKFLOW, WORKFLOW));
  assert.ok(identityMatches(WORKFLOW, "https://github.com/acme/*/.github/workflows/agent-review.yml@refs/heads/main"));
  assert.ok(!identityMatches(WORKFLOW.replace("main", "evil"), "https://github.com/acme/api/.github/workflows/agent-review.yml@refs/heads/main"));
  assert.ok(!identityMatches("https://github.com/acmeXapi", "https://github.com/acme.api"));
});

test("reads the workflow identity from the signing certificate", () => {
  assert.equal(bundleIdentity({ verificationMaterial: { certificate: { rawBytes: CERT } } }), WORKFLOW);
});

test("a valid signature names its signer, trusted or not", async () => {
  const root = repo();
  const att = attest(root, true);
  assert.deepEqual(await checkSignature(att as unknown as Record<string, unknown>, { trusted: [WORKFLOW] }, ok), { state: "valid", identity: WORKFLOW, issuer: "https://token.actions.githubusercontent.com", trusted: true });
  const other = await checkSignature(att as unknown as Record<string, unknown>, { trusted: ["https://github.com/acme/api/.github/workflows/other.yml@refs/heads/main"] }, ok);
  assert.equal(other.state === "valid" && other.trusted, false);
});

test("editing a signed attestation breaks the signature", async () => {
  const root = repo();
  const att = attest(root, true);
  const tampered = { ...att, verdict: "pass", note: "added after signing" };
  const r = await checkSignature(tampered as unknown as Record<string, unknown>, undefined, ok);
  assert.equal(r.state, "invalid");
});

test("a signature Sigstore rejects is invalid; an unreachable Sigstore is unchecked", async () => {
  const root = repo();
  const att = attest(root, true) as unknown as Record<string, unknown>;
  assert.equal((await checkSignature(att, undefined, bad)).state, "invalid");
  assert.equal((await checkSignature(att, undefined, offline)).state, "unchecked");
});

test("without a signature policy, unsigned verdicts pass as before and signed ones record the signer", async () => {
  const root = repo();
  attest(root, false, "a.json");
  attest(root, true, "b.json");
  const report = await verifyWithSignatures({ root, policy: null, verify: ok });
  assert.equal(report.ok, true);
  assert.deepEqual(report.results.map((r) => r.signer ?? null), [null, WORKFLOW]);
});

test("require: an unsigned verdict is refused as unsigned", async () => {
  const root = repo();
  attest(root, false);
  const report = await verifyWithSignatures({ root, policy: policy({ require: true, trusted: [WORKFLOW] }), verify: ok });
  assert.equal(report.ok, false);
  assert.equal(report.results[0]!.status, "unsigned");
});

test("require: a verdict signed by a workflow the policy doesn't trust is refused", async () => {
  const root = repo();
  attest(root, true);
  const report = await verifyWithSignatures({ root, policy: policy({ require: true, trusted: ["https://github.com/acme/api/.github/workflows/release.yml@refs/heads/main"] }), verify: ok });
  assert.equal(report.results[0]!.status, "signer_not_trusted");
});

test("require: a verdict signed by a trusted workflow passes", async () => {
  const root = repo();
  attest(root, true);
  const report = await verifyWithSignatures({ root, policy: policy({ require: true, trusted: [WORKFLOW] }), verify: ok });
  assert.equal(report.ok, true);
  assert.equal(report.results[0]!.signer, WORKFLOW);
});

test("a tampered signature is refused even when signatures aren't required", async () => {
  const root = repo();
  const att = attest(root, true);
  writeFileSync(join(root, DIR, "security-reviewer.json"), JSON.stringify({ ...att, by: "someone-else" }, null, 2));
  const report = await verifyWithSignatures({ root, policy: null, verify: ok });
  assert.equal(report.results[0]!.status, "signature_invalid");
});

test("require: Sigstore unreachable is 'couldn't run', never a pass", async () => {
  const root = repo();
  attest(root, true);
  await assert.rejects(verifyWithSignatures({ root, policy: policy({ require: true, trusted: [WORKFLOW] }), verify: offline }), /couldn't check signatures/);
});

test("the plain synchronous gate treats a signed attestation without a check as unsigned when required", () => {
  const root = repo();
  attest(root, true);
  const report = verifyAttestations({ root, policy: policy({ require: true, trusted: [WORKFLOW] }) });
  assert.equal(report.results[0]!.status, "unsigned");
});

test("policy: require without a trusted list is rejected", () => {
  const root = repo();
  mkdirSync(join(root, ".slipmark"), { recursive: true });
  writeFileSync(join(root, ".slipmark/policy.json"), JSON.stringify({ schema: POLICY_SCHEMA, signatures: { require: true } }));
  assert.throws(() => loadPolicy(root), /needs a "trusted" list/);
});

test("a v1 attestation can carry a signature too", async () => {
  const root = repo();
  const att = attest(root, true);
  assert.equal(att.schema, "slipmark/attestation@1");
  const saved = JSON.parse(readFileSync(join(root, DIR, "security-reviewer.json"), "utf8"));
  assert.ok(saved.signature.bundle.dsseEnvelope);
  const report = await verifyWithSignatures({ root, policy: policy({ require: true, trusted: [WORKFLOW] }), verify: ok });
  assert.equal(report.ok, true);
});

// A genuine verdict signed through Sigstore by .github/workflows/signed-fixture.yml (see that file).
const REAL = JSON.parse(readFileSync(new URL("../../test/fixtures/signed-attestation.json", import.meta.url), "utf8"));
const REAL_ID = readFileSync(new URL("../../test/fixtures/signed-attestation.identity", import.meta.url), "utf8").trim();

test("real signature: the Fulcio certificate names the workflow that signed it", () => {
  assert.equal(bundleIdentity(REAL.signature.bundle), REAL_ID);
});

test("real signature: the envelope covers exactly this attestation", async () => {
  const r = await checkSignature(REAL, { trusted: [REAL_ID] }, ok);
  assert.deepEqual(r, { state: "valid", identity: REAL_ID, issuer: "https://token.actions.githubusercontent.com", trusted: true });
  assert.equal((await checkSignature({ ...REAL, verdict: "cleared" }, undefined, ok)).state, "invalid");
});
