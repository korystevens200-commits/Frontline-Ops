/* Small render helpers shared across screens. */
import { html } from "../html.js";
import { formatDateTime, relativeTime } from "../time.js";

export const OUTCOMES = [
  { value: "no_answer",       label: "No answer" },
  { value: "gatekeeper",      label: "Gatekeeper" },
  { value: "spoke_to_owner",  label: "Spoke to owner" },
  { value: "callback",        label: "Callback" },
  { value: "not_interested",  label: "Not interested" },
  { value: "trial_agreed",    label: "Trial agreed" },
  { value: "dead",            label: "Dead" },
];

export const OUTCOME_LABELS = Object.fromEntries(OUTCOMES.map((o) => [o.value, o.label]));

export const COMPANY_STATUSES = [
  "new", "contacted", "callback", "trial", "client", "not_interested", "dead",
];

export const STATUS_LABELS = {
  new: "New",
  contacted: "Contacted",
  callback: "Callback",
  trial: "Trial",
  client: "Client",
  not_interested: "Not interested",
  dead: "Dead",
};

export function statusPill(status) {
  return html`<span class="pill pill-${status}">${STATUS_LABELS[status] ?? status}</span>`;
}

export function tierPill(tier) {
  return html`<span class="pill ${tier === "A" ? "pill-a" : "pill-b"}">Tier ${tier}</span>`;
}

/* Display form for an E.164 number: +13055551234 -> (305) 555-1234 */
export function displayPhone(phone) {
  const match = String(phone ?? "").match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : String(phone ?? "");
}

export function money(cents) {
  const n = Number(cents ?? 0) / 100;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 === 0 ? 0 : 2,
                                         maximumFractionDigits: 2 })}`;
}

export function percent(numerator, denominator) {
  if (!denominator) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/* The qualifying number, coloured by the rule that under 4 is a disqualify. */
export function missedCallsBadge(value) {
  if (value === null || value === undefined) return html``;
  const hot = Number(value) >= 4;
  return html`<span class="mcw ${hot ? "mcw-hot" : "mcw-cold"}">${value}/wk</span>`;
}

export function callRow(call) {
  return html`
<div class="callrow">
  <div class="row-title">
    ${OUTCOME_LABELS[call.outcome] ?? call.outcome}
    ${call.missed_calls_per_week !== null ? missedCallsBadge(call.missed_calls_per_week) : ""}
  </div>
  <div class="row-sub">
    ${call.called_by} · ${formatDateTime(call.called_at)}
    ${call.callback_at ? html` · callback ${formatDateTime(call.callback_at)}` : ""}
  </div>
  ${call.objection ? html`<div class="row-sub">Objection: ${call.objection}</div>` : ""}
  ${call.notes ? html`<div class="small mt-5">${call.notes}</div>` : ""}
</div>`;
}

export { formatDateTime, relativeTime };
