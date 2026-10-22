/**
 * Slipmark Cloud upload: send this run's verify report and attestations to the
 * hosted ledger, authenticated by the GitHub Actions OIDC token.
 *
 * Nothing secret is configured: the workflow grants `id-token: write`, GitHub
 * mints a short-lived token naming this repository, commit and run, and the
 * ledger trusts only that token for where the record belongs.
 */
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { listAttestationFiles, verifyAttestations, type VerifyReport } from "../attest/attestation.js";

export const DEFAULT_CLOUD_URL = "https://app.slipmark.dev/api/ingest";
export const OIDC_AUDIENCE = "slipmark";

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface UploadResult {
  ok: boolean;
  status: number;
  url: string | null;
  runId?: string;
  seq?: number;
  entryHash?: string;
  message: string;
}

/** Ask the Actions runtime for an OIDC token. Null outside Actions or without id-token: write. */
export async function getOidcToken(env: NodeJS.ProcessEnv, fetchImpl: FetchLike): Promise<string | null> {
  const reqUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!reqUrl || !reqToken) return null;
  const sepChar = reqUrl.includes("?") ? "&" : "?";
  const res = await fetchImpl(`${reqUrl}${sepChar}audience=${encodeURIComponent(OIDC_AUDIENCE)}`, {
    headers: { authorization: `bearer ${reqToken}`, accept: "application/json" },
  });
  if (!res.ok) return null;
  try {
    const value = (JSON.parse(await res.text()) as { value?: string }).value;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** The attestation files as uploaded: parsed JSON plus their repo-relative path. Unparseable files are skipped (verify already reports them). */
export function collectAttestations(root: string, dir: string): { file: string; attestation: unknown }[] {
  const out: { file: string; attestation: unknown }[] = [];
  for (const abs of listAttestationFiles(resolve(root, dir))) {
    try {
      out.push({ file: relative(resolve(root), abs).split(sep).join("/"), attestation: JSON.parse(readFileSync(abs, "utf8")) });
    } catch {
      /* invalid JSON: already an `invalid` result in the report */
    }
  }
  return out;
}

export async function uploadRun(opts: {
  root?: string;
  dir?: string;
  require?: string[];
  url?: string;
  clientVersion: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  report?: VerifyReport;
}): Promise<UploadResult> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const root = resolve(opts.root ?? process.cwd());
  const dir = opts.dir ?? ".slipmark/attestations";
  const url = opts.url ?? env.SLIPMARK_CLOUD_URL ?? DEFAULT_CLOUD_URL;

  const token = await getOidcToken(env, fetchImpl);
  if (!token) {
    return {
      ok: false,
      status: 0,
      url: null,
      message:
        "No GitHub Actions OIDC token. Run this inside GitHub Actions with `permissions: id-token: write` on the job.",
    };
  }

  const report = opts.report ?? verifyAttestations({ root, dir, require: opts.require });
  const body = JSON.stringify({ report, attestations: collectAttestations(root, dir), client_version: opts.clientVersion });

  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
  } catch (e) {
    return { ok: false, status: 0, url: null, message: `Could not reach Slipmark Cloud: ${e instanceof Error ? e.message : String(e)}` };
  }
  const text = await res.text();
  let parsed: { url?: string | null; run_id?: string; seq?: number; entry_hash?: string; error?: string; note?: string } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    return { ok: false, status: res.status, url: null, message: `Slipmark Cloud refused the upload (${res.status}): ${parsed.error ?? text.slice(0, 200)}` };
  }
  return {
    ok: true,
    status: res.status,
    url: parsed.url ?? null,
    runId: parsed.run_id,
    seq: parsed.seq,
    entryHash: parsed.entry_hash,
    message: parsed.url ? `Recorded as ledger entry #${parsed.seq}: ${parsed.url}` : (parsed.note ?? `Recorded as ledger entry #${parsed.seq}.`),
  };
}

/** Markdown for $GITHUB_STEP_SUMMARY. */
export function summaryMarkdown(report: VerifyReport, result: UploadResult): string {
  const verified = report.results.filter((r) => r.status === "verified").length;
  const head = report.ok ? "Slipmark: every verdict matches the files" : "Slipmark: gate refused";
  const lines = [`### ${head}`, "", `${verified} verified · ${report.failures.length} refused`, ""];
  if (result.ok && result.url) lines.push(`[Proof record #${result.seq}](${result.url}) · entry hash \`${result.entryHash?.slice(0, 16)}…\``);
  else if (result.ok) lines.push(result.message);
  else lines.push(`Cloud upload skipped: ${result.message}`);
  return lines.join("\n") + "\n";
}
