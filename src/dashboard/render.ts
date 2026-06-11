/**
 * Self-contained HTML dashboard renderer (zero runtime dependencies, works
 * offline via file://). This is the visual prototype of the hosted cloud — the
 * same data model, rendered as a static page instead of a live web app.
 */
import type { DashboardData, LockSummary, RunSummary } from "./data.js";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusColor(status: string): string {
  return status === "pass" ? "#16a34a" : status === "drift" ? "#dc2626" : status === "error" ? "#d97706" : "#6b7280";
}

function tierColor(tier: string | null): string {
  return tier === "high" ? "#dc2626" : tier === "medium" ? "#d97706" : tier === "low" ? "#2563eb" : "#6b7280";
}

function trendSvg(runs: RunSummary[]): string {
  // Oldest → newest, drift rate as bars.
  const ordered = [...runs].reverse();
  const w = 460;
  const h = 60;
  const n = Math.max(ordered.length, 1);
  const bw = Math.min(28, (w - (n - 1) * 4) / n);
  const bars = ordered
    .map((r, i) => {
      const rate = r.total > 0 ? r.drifted / r.total : 0;
      const bh = Math.max(2, Math.round(rate * (h - 8)));
      const x = i * (bw + 4);
      const y = h - bh;
      const color = r.drifted > 0 ? "#dc2626" : "#16a34a";
      return `<rect x="${x}" y="${y}" width="${bw.toFixed(1)}" height="${bh}" rx="2" fill="${color}"><title>${esc(r.timestamp)} — ${r.drifted}/${r.total} drifted</title></rect>`;
    })
    .join("");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="drift trend">${bars}</svg>`;
}

function confidenceBar(lock: LockSummary): string {
  if (lock.status === "pass") return `<span class="muted">—</span>`;
  const pct = typeof lock.confidence === "number" ? Math.round(lock.confidence * 100) : 0;
  const color = tierColor(lock.confidenceTier);
  return `<div class="bar"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
    <span class="bar-label" style="color:${color}">${lock.confidenceTier ?? "n/a"}${pct ? ` ${pct}%` : ""}</span>`;
}

function lockCard(lock: LockSummary): string {
  const color = statusColor(lock.status);
  const repair =
    lock.repairPrompt && lock.status !== "pass"
      ? `<details class="repair"><summary>Repair prompt</summary><pre>${esc(lock.repairPrompt)}</pre></details>`
      : "";
  const sigs = lock.signatures.length
    ? `<div class="sigs">${lock.signatures.map((s) => `<span class="chip">${esc(s)}</span>`).join("")}</div>`
    : "";
  const explain = lock.confidenceExplanation ? `<div class="explain">${esc(lock.confidenceExplanation)}</div>` : "";
  return `<div class="card">
    <div class="card-head">
      <span class="dot" style="background:${color}"></span>
      <div class="card-title"><strong>${esc(lock.name)}</strong><code>${esc(lock.key)}</code></div>
      <span class="badge" style="background:${color}1a;color:${color}">${esc(lock.status)}</span>
      ${lock.severity && lock.status !== "pass" ? `<span class="sev">sev: ${esc(lock.severity)}</span>` : ""}
    </div>
    <div class="conf">${confidenceBar(lock)}</div>
    ${explain}${sigs}${repair}
  </div>`;
}

function runRow(run: RunSummary): string {
  const ok = run.drifted === 0 && run.errored === 0;
  return `<tr>
    <td><span class="dot" style="background:${ok ? "#16a34a" : "#dc2626"}"></span> ${esc(new Date(run.timestamp).toLocaleString())}</td>
    <td><code>${esc(run.packId)}</code></td>
    <td>${run.passed}</td>
    <td>${run.drifted}</td>
    <td>${run.errored}</td>
  </tr>`;
}

export function renderDashboardHtml(data: DashboardData): string {
  const latest = data.runs[0];
  const kpis = latest
    ? `<div class="kpis">
        <div class="kpi"><div class="kpi-n" style="color:#16a34a">${latest.passed}</div><div class="kpi-l">passing</div></div>
        <div class="kpi"><div class="kpi-n" style="color:#dc2626">${latest.drifted}</div><div class="kpi-l">drifted</div></div>
        <div class="kpi"><div class="kpi-n" style="color:#d97706">${latest.errored}</div><div class="kpi-l">errored</div></div>
        <div class="kpi"><div class="kpi-n">${latest.total}</div><div class="kpi-l">locks</div></div>
      </div>`
    : `<p class="muted">No runs yet.</p>`;

  const latestCards = latest ? latest.locks.map(lockCard).join("") : "";
  const history = data.runs.length ? data.runs.map(runRow).join("") : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DriftGuard — ${esc(data.project)}</title>
<style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  *{box-sizing:border-box}
  body{margin:0;background:#0b1220;color:#e5e7eb}
  .wrap{max-width:920px;margin:0 auto;padding:28px 20px 60px}
  header{display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid #1f2a3d;padding-bottom:14px;margin-bottom:22px}
  .brand{font-size:20px;font-weight:700}
  .brand span{color:#67e8f9}
  .sub{color:#94a3b8;font-size:13px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin:28px 0 12px}
  .kpis{display:flex;gap:14px;flex-wrap:wrap}
  .kpi{background:#111c30;border:1px solid #1f2a3d;border-radius:10px;padding:14px 18px;min-width:96px}
  .kpi-n{font-size:26px;font-weight:700}
  .kpi-l{color:#94a3b8;font-size:12px}
  .panel{background:#111c30;border:1px solid #1f2a3d;border-radius:10px;padding:16px}
  .card{background:#0f1a2c;border:1px solid #1f2a3d;border-radius:10px;padding:14px;margin-bottom:12px}
  .card-head{display:flex;align-items:center;gap:10px}
  .dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex:none}
  .card-title{display:flex;flex-direction:column;gap:2px;flex:1}
  .card-title code{color:#94a3b8;font-size:12px}
  .badge{font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px;text-transform:uppercase}
  .sev{font-size:12px;color:#fca5a5}
  .conf{display:flex;align-items:center;gap:10px;margin:10px 0 4px}
  .bar{flex:1;height:8px;background:#1f2a3d;border-radius:6px;overflow:hidden}
  .bar-fill{height:100%}
  .bar-label{font-size:12px;font-weight:600}
  .explain{color:#cbd5e1;font-size:13px;margin:6px 0}
  .sigs{margin:8px 0}
  .chip{display:inline-block;background:#1e293b;color:#93c5fd;border-radius:6px;padding:2px 8px;font-size:12px;margin-right:6px}
  details.repair{margin-top:8px}
  details.repair summary{cursor:pointer;color:#67e8f9;font-size:13px}
  details.repair pre{white-space:pre-wrap;background:#0b1220;border:1px solid #1f2a3d;border-radius:8px;padding:12px;font-size:12px;overflow:auto;max-height:420px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #1f2a3d}
  th{color:#94a3b8;font-weight:600;font-size:12px}
  .muted{color:#64748b}
  footer{margin-top:40px;color:#64748b;font-size:12px;border-top:1px solid #1f2a3d;padding-top:14px}
  .preview{background:#1e293b;color:#fcd34d;border:1px solid #3b475c;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:18px}
</style></head>
<body><div class="wrap">
  <header>
    <div><div class="brand">Drift<span>Guard</span></div><div class="sub">${esc(data.project)}</div></div>
    <div class="sub">generated ${esc(new Date(data.generatedAt).toLocaleString())}</div>
  </header>

  <div class="preview">Preview dashboard — rendered from a local run-history file. The hosted cloud serves this same view from a database + API.</div>

  <h2>Latest run</h2>
  ${kpis}

  <h2>Drift trend</h2>
  <div class="panel">${trendSvg(data.runs)}<div class="sub" style="margin-top:8px">drift rate per run (oldest → newest)</div></div>

  <h2>Locks (latest run)</h2>
  ${latestCards || '<p class="muted">No locks.</p>'}

  <h2>Run history</h2>
  <div class="panel"><table>
    <thead><tr><th>When</th><th>Pack</th><th>Pass</th><th>Drift</th><th>Error</th></tr></thead>
    <tbody>${history || '<tr><td colspan="5" class="muted">No runs.</td></tr>'}</tbody>
  </table></div>

  <footer>DriftGuard — part of Reply Intelligence Group. Static preview; not connected to a backend.</footer>
</div></body></html>`;
}
