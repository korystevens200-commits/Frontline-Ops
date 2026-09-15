import { html, queryString } from "../html.js";
import { layout } from "./layout.js";
import {
  displayPhone, statusPill, tierPill, missedCallsBadge, relativeTime,
  COMPANY_STATUSES, STATUS_LABELS,
} from "./components.js";

export const SORTS = [
  { value: "tier",         label: "Tier, then oldest" },
  { value: "name",         label: "Name A–Z" },
  { value: "last_called",  label: "Least recently called" },
  { value: "recent_call",  label: "Most recently called" },
  { value: "missed_calls", label: "Missed calls/week" },
  { value: "rating",       label: "Google rating" },
  { value: "reviews",      label: "Review count" },
  { value: "created",      label: "Newest import" },
];

export const CALLED_WINDOWS = [
  { value: "",       label: "Any time" },
  { value: "never",  label: "Never called" },
  { value: "today",  label: "Called today" },
  { value: "7d",     label: "Called last 7 days" },
  { value: "30d",    label: "Called last 30 days" },
  { value: "stale",  label: "Not called in 30 days" },
];

export function pipelinePage({
  operator, rows, total, filters, niches, page, pageSize, flash,
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const body = html`
<h1>Pipeline</h1>

<form method="GET" action="/pipeline" class="card">
  <div class="filters">
    <input class="full" type="search" name="q" placeholder="Search name or phone"
           value="${filters.q ?? ""}" maxlength="120">

    <select name="status" aria-label="Status">
      <option value="">All statuses</option>
      ${COMPANY_STATUSES.map((s) => html`
        <option value="${s}" ${filters.status === s ? "selected" : ""}>${STATUS_LABELS[s]}</option>`)}
    </select>

    <select name="tier" aria-label="Tier">
      <option value="">All tiers</option>
      <option value="A" ${filters.tier === "A" ? "selected" : ""}>Tier A</option>
      <option value="B" ${filters.tier === "B" ? "selected" : ""}>Tier B</option>
    </select>

    <select name="niche" aria-label="Niche">
      <option value="">All niches</option>
      ${niches.map((n) => html`
        <option value="${n}" ${filters.niche === n ? "selected" : ""}>${n}</option>`)}
    </select>

    <select name="called" aria-label="Last called">
      ${CALLED_WINDOWS.map((w) => html`
        <option value="${w.value}" ${filters.called === w.value ? "selected" : ""}>${w.label}</option>`)}
    </select>

    <select class="full" name="sort" aria-label="Sort by">
      ${SORTS.map((s) => html`
        <option value="${s.value}" ${filters.sort === s.value ? "selected" : ""}>${s.label}</option>`)}
    </select>
  </div>

  <button class="btn btn-primary" type="submit">Apply</button>
  ${hasFilters(filters) ? html`
    <p class="text-center mt-10">
      <a class="tap-link muted" href="/pipeline">Clear filters</a>
    </p>` : ""}
</form>

<div class="card-head">
  <span class="section-title">${total} compan${total === 1 ? "y" : "ies"}</span>
  ${pages > 1 ? html`<span class="tiny muted">Page ${page} of ${pages}</span>` : ""}
</div>

<div class="card">
  ${rows.length === 0
    ? html`<div class="empty">Nothing matches those filters.</div>`
    : rows.map((row) => companyRow(row))}
</div>

${pages > 1 ? pager({ filters, page, pages }) : ""}`;

  return layout({ title: "Pipeline", operator, active: "pipeline", body, flash });
}

function companyRow(row) {
  return html`
<div class="row">
  <div class="row-main">
    <div class="row-title"><a href="/company/${row.id}">${row.name}</a></div>
    <div class="row-sub">
      ${displayPhone(row.phone)}${row.niche ? html` · ${row.niche}` : ""}${row.city ? html` · ${row.city}` : ""}
    </div>
    <div class="row-sub mt-5">
      ${tierPill(row.tier)} ${statusPill(row.status)}
      ${row.best_missed_calls !== null ? missedCallsBadge(row.best_missed_calls) : ""}
    </div>
  </div>
  <div class="row-side">
    <div>${row.last_called_at ? relativeTime(row.last_called_at) : "never called"}</div>
    ${row.call_count ? html`<div class="tiny">${row.call_count} call${row.call_count === 1 ? "" : "s"}</div>` : ""}
    ${row.google_rating !== null ? html`<div class="tiny">${row.google_rating}★ (${row.review_count ?? 0})</div>` : ""}
  </div>
</div>`;
}

function pager({ filters, page, pages }) {
  const link = (p) => `/pipeline${queryString({ ...filters, page: p })}`;
  return html`
<div class="row row-split">
  ${page > 1
    ? html`<a class="btn btn-secondary btn-sm btn-auto" href="${link(page - 1)}">Previous</a>`
    : html`<span></span>`}
  <span class="tiny muted">Page ${page} of ${pages}</span>
  ${page < pages
    ? html`<a class="btn btn-secondary btn-sm btn-auto" href="${link(page + 1)}">Next</a>`
    : html`<span></span>`}
</div>`;
}

function hasFilters(filters) {
  return Boolean(filters.q || filters.status || filters.tier || filters.niche || filters.called);
}
