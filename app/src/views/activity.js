import { html, queryString } from "../html.js";
import { layout } from "./layout.js";
import { formatDateTime } from "./components.js";

export function activityPage({ operator, rows, actors, filters, page, pages, flash }) {
  const body = html`
<h1>Activity</h1>
<p class="muted small mb-12">
  Every write, in order. Append-only — nothing here is edited or deleted.
</p>

<form method="GET" action="/activity" class="card">
  <div class="filters">
    <select name="actor" aria-label="Who">
      <option value="">Everyone</option>
      ${actors.map((name) => html`
        <option value="${name}" ${filters.actor === name ? "selected" : ""}>${name}</option>`)}
    </select>
    <select name="entity" aria-label="Type">
      <option value="">All types</option>
      ${["call", "company", "trial", "client", "import"].map((t) => html`
        <option value="${t}" ${filters.entity === t ? "selected" : ""}>${t}</option>`)}
    </select>
  </div>
  <button class="btn btn-secondary" type="submit">Filter</button>
</form>

<div class="card">
  ${rows.length === 0
    ? html`<div class="empty">Nothing logged yet.</div>`
    : rows.map((row) => html`
      <div class="callrow">
        <div class="row-title small">
          ${row.actor} · ${row.action}
          ${row.entity_type === "company" && row.entity_id
            ? html` · <a href="/company/${row.entity_id}">open</a>` : ""}
        </div>
        <div class="row-sub">${formatDateTime(row.created_at)} · ${row.entity_type}</div>
        ${row.detail ? html`<div class="small mt-4">${row.detail}</div>` : ""}
      </div>`)}
</div>

${pages > 1 ? html`
<div class="row row-split">
  ${page > 1
    ? html`<a class="btn btn-secondary btn-sm btn-auto" href="/activity${queryString({ ...filters, page: page - 1 })}">Previous</a>`
    : html`<span></span>`}
  <span class="tiny muted">Page ${page} of ${pages}</span>
  ${page < pages
    ? html`<a class="btn btn-secondary btn-sm btn-auto" href="/activity${queryString({ ...filters, page: page + 1 })}">Next</a>`
    : html`<span></span>`}
</div>` : ""}`;

  return layout({ title: "Activity", operator, active: "activity", body, flash });
}
