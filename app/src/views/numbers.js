import { html, raw } from "../html.js";
import { layout } from "./layout.js";
import { money, percent, OUTCOME_LABELS } from "./components.js";

export function numbersPage({ operator, f, series, outcomes, missed, flash }) {
  const body = html`
<h1>Numbers</h1>

<div class="stat-grid mb-12">
  <div class="stat"><div class="n">${f.dials}</div><div class="l">Total dials</div></div>
  <div class="stat accent"><div class="n">${f.conversations}</div><div class="l">Conversations</div></div>
  <div class="stat"><div class="n">${f.trials}</div><div class="l">Trials installed</div></div>
  <div class="stat win"><div class="n">${f.clients_active}</div><div class="l">Paying clients</div></div>
</div>

<div class="stat-grid mb-12">
  <div class="stat money"><div class="n">${money(f.mrr_cents)}</div><div class="l">MRR</div></div>
  <div class="stat money"><div class="n">${money(f.setup_cents)}</div><div class="l">Setup collected</div></div>
  <div class="stat money"><div class="n">${money(f.collected_cents)}</div><div class="l">Total collected</div></div>
  <div class="stat"><div class="n">${f.trials_active}</div><div class="l">Trials running</div></div>
</div>

<div class="card">
  <div class="card-head"><h2>Funnel</h2></div>
  <div class="funnel-step">
    <span class="funnel-label">Companies in list</span>
    <span class="funnel-n">${f.companies}</span>
    <span class="funnel-rate">—</span>
  </div>
  <div class="funnel-step">
    <span class="funnel-label">Dials placed</span>
    <span class="funnel-n">${f.dials}</span>
    <span class="funnel-rate">—</span>
  </div>
  <div class="funnel-step">
    <span class="funnel-label">Conversations</span>
    <span class="funnel-n">${f.conversations}</span>
    <span class="funnel-rate" title="conversations per dial">${percent(f.conversations, f.dials)}</span>
  </div>
  <div class="funnel-step">
    <span class="funnel-label">Trials installed</span>
    <span class="funnel-n">${f.trials}</span>
    <span class="funnel-rate" title="trials per conversation">${percent(f.trials, f.conversations)}</span>
  </div>
  <div class="funnel-step">
    <span class="funnel-label">Paying clients</span>
    <span class="funnel-n">${f.clients_ever}</span>
    <span class="funnel-rate" title="clients per trial">${percent(f.clients_ever, f.trials)}</span>
  </div>
  <p class="tiny muted mt-10">
    Rate is conversion from the stage directly above.
    Dial→client overall: ${percent(f.clients_ever, f.dials)}.
  </p>
</div>

<div class="card">
  <div class="card-head">
    <h2>Dials per day</h2>
    <span class="tiny muted">last 30 days</span>
  </div>
  ${dialsChart(series)}
  <p class="tiny muted mt-8">
    <span class="c-aqua">■</span> dials ·
    <span class="c-success">■</span> conversations
  </p>
</div>

<div class="card">
  <div class="card-head"><h2>What happens when we dial</h2></div>
  ${outcomes.length === 0
    ? html`<div class="empty">No calls logged yet.</div>`
    : outcomes.map((row) => html`
      <div class="funnel-step">
        <span class="funnel-label">${OUTCOME_LABELS[row.outcome] ?? row.outcome}</span>
        <span class="funnel-n">${row.n}</span>
        <span class="funnel-rate">${percent(row.n, f.dials)}</span>
      </div>`)}
</div>

<div class="card">
  <div class="card-head"><h2>Qualifying</h2></div>
  <div class="funnel-step">
    <span class="funnel-label">Owners who gave a number</span>
    <span class="funnel-n">${missed.answered}</span>
    <span class="funnel-rate">—</span>
  </div>
  <div class="funnel-step">
    <span class="funnel-label">At 4+ missed calls/week</span>
    <span class="funnel-n">${missed.qualified}</span>
    <span class="funnel-rate">${percent(missed.qualified, missed.answered)}</span>
  </div>
  <div class="funnel-step">
    <span class="funnel-label">Average missed calls/week</span>
    <span class="funnel-n">${missed.avg_missed}</span>
    <span class="funnel-rate">—</span>
  </div>
</div>

<div class="card">
  <div class="card-head"><h2>Retention</h2></div>
  <div class="funnel-step">
    <span class="funnel-label">Active clients</span>
    <span class="funnel-n">${f.clients_active}</span>
    <span class="funnel-rate">—</span>
  </div>
  <div class="funnel-step">
    <span class="funnel-label">Churned</span>
    <span class="funnel-n">${f.clients_churned}</span>
    <span class="funnel-rate">${percent(f.clients_churned, f.clients_ever)}</span>
  </div>
</div>`;

  return layout({ title: "Numbers", operator, active: "numbers", body, flash });
}

/* Inline SVG bar chart. No chart library, no client-side JavaScript: the
   server already knows every number, so the markup is the chart.
   A viewBox makes it scale to any width without a horizontal scrollbar. */
function dialsChart(series) {
  const W = 320;
  const H = 110;
  const PAD_L = 22;
  const PAD_B = 16;
  const PAD_T = 6;
  const plotW = W - PAD_L - 4;
  const plotH = H - PAD_B - PAD_T;

  const max = Math.max(1, ...series.map((d) => d.dials));
  /* A tidy axis top, so the scale reads as a round number. */
  const step = max <= 5 ? 1 : max <= 20 ? 5 : max <= 50 ? 10 : 25;
  const top = Math.ceil(max / step) * step;

  const slot = plotW / series.length;
  const barW = Math.max(2, slot * 0.68);

  const bars = series.map((day, i) => {
    const x = PAD_L + i * slot + (slot - barW) / 2;
    const dialsH = (day.dials / top) * plotH;
    const convH = (day.conversations / top) * plotH;
    const label = `${day.day instanceof Date ? day.day.toISOString().slice(0, 10) : day.day}: ${day.dials} dials, ${day.conversations} conversations`;
    return `<g><title>${escapeXml(label)}</title>` +
      `<rect x="${round(x)}" y="${round(PAD_T + plotH - dialsH)}" width="${round(barW)}" height="${round(dialsH)}" fill="#00E5FF" rx="1"/>` +
      (convH > 0
        ? `<rect x="${round(x)}" y="${round(PAD_T + plotH - convH)}" width="${round(barW)}" height="${round(convH)}" fill="#00E5A0" rx="1"/>`
        : "") +
      `</g>`;
  }).join("");

  const gridLines = [0, 0.5, 1].map((frac) => {
    const y = PAD_T + plotH - frac * plotH;
    const value = Math.round(top * frac);
    return `<line x1="${PAD_L}" y1="${round(y)}" x2="${W - 4}" y2="${round(y)}" stroke="#262633" stroke-width="0.5"/>` +
      `<text x="${PAD_L - 4}" y="${round(y + 3)}" fill="#8A8FA0" font-size="7" text-anchor="end">${value}</text>`;
  }).join("");

  /* Label first, middle and last day only -- 30 dates will not fit at 380px. */
  const marks = [0, Math.floor(series.length / 2), series.length - 1];
  const dayLabels = marks.map((i) => {
    const day = series[i];
    if (!day) return "";
    const text = formatDay(day.day);
    const x = PAD_L + i * slot + slot / 2;
    const anchor = i === 0 ? "start" : i === series.length - 1 ? "end" : "middle";
    return `<text x="${round(x)}" y="${H - 4}" fill="#8A8FA0" font-size="7" text-anchor="${anchor}">${escapeXml(text)}</text>`;
  }).join("");

  return raw(
    `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="Dials per day for the last 30 days, peak ${max}" preserveAspectRatio="xMidYMid meet">` +
    gridLines + bars + dayLabels +
    `</svg>`
  );
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function formatDay(day) {
  const text = day instanceof Date ? day.toISOString().slice(0, 10) : String(day).slice(0, 10);
  const [, m, d] = text.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}
