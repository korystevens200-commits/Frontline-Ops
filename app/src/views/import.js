/* Import screens: pick or paste a list, read the report, confirm. */
import { html } from "../html.js";
import { layout } from "./layout.js";
import { displayPhone, formatDateTime } from "./components.js";

const REPORT_LIMIT = 50;

export function importPage({ operator, flash, error = null }) {
  const body = html`
<h1>Import prospects</h1>
<p class="muted small mb-12">
  A CSV with <strong>company_name</strong>, <strong>phone</strong> and <strong>tier</strong> (A or B), plus
  niche, address, city, zip, google_rating, review_count and notes if you have them. Nothing is written
  until you have seen the report and confirmed.
</p>

${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ""}

<form method="POST" action="/import" enctype="multipart/form-data" class="card">
  <div class="field">
    <label for="file">CSV file</label>
    <input id="file" name="file" type="file" accept=".csv,text/csv,text/plain">
  </div>
  <details>
    <summary>Or paste the list instead</summary>
    <div class="field">
      <label for="csv_text">CSV text, header row first</label>
      <textarea id="csv_text" name="csv_text" rows="6"
                placeholder="company_name,phone,tier&#10;Aire Frio AC Repair,3055550111,A"></textarea>
    </div>
  </details>
  <div class="field">
    <label for="source">Label this batch <span class="muted">(optional)</span></label>
    <input id="source" name="source" maxlength="80" placeholder="hialeah batch 2">
  </div>
  <button class="btn btn-primary" type="submit">Check the list</button>
</form>

<div class="card">
  <div class="section-title mb-8">Safe to repeat</div>
  <p class="small muted">
    Phone number is the identity. Importing a business that is already in the list updates it rather
    than adding a second copy, and never touches its status, call history or your notes.
  </p>
</div>`;

  return layout({ title: "Import", operator, active: "pipeline", body, flash });
}

export function importReviewPage({ operator, batch, check, flash, error = null }) {
  const pending = batch.status === "pending";
  const body = html`
<h1>${pending ? "Check the import" : batch.status === "imported" ? "Imported" : "Discarded"}</h1>
<p class="muted small mb-12">
  ${batch.filename || "Upload"} · ${batch.source} · by ${batch.created_by} · ${formatDateTime(batch.created_at)}
</p>

${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ""}

${batch.status === "imported" ? html`
  <div class="card card-raised">
    <div class="stat-grid">
      <div class="stat win"><div class="n">${batch.created_count}</div><div class="l">Added</div></div>
      <div class="stat"><div class="n">${batch.updated_count}</div><div class="l">Updated</div></div>
    </div>
    <a class="btn btn-primary mt-12" href="/today">Start calling</a>
  </div>` : ""}

${pending ? html`
<div class="stat-grid mb-12">
  <div class="stat"><div class="n">${check.total}</div><div class="l">Rows in file</div></div>
  <div class="stat win"><div class="n">${check.toImport.length}</div><div class="l">Will import</div></div>
  <div class="stat"><div class="n">${check.rejected.length}</div><div class="l">Rejected</div></div>
  <div class="stat"><div class="n">${check.dupes.length}</div><div class="l">Duplicates in file</div></div>
</div>

${check.rejected.length ? html`
  <div class="card">
    <div class="section-title mb-8">Rejected — not imported</div>
    ${check.rejected.slice(0, REPORT_LIMIT).map((r) => html`<div class="row-sub">Line ${r.line}: ${r.why}</div>`)}
    ${check.rejected.length > REPORT_LIMIT ? html`<div class="row-sub">…and ${check.rejected.length - REPORT_LIMIT} more</div>` : ""}
  </div>` : ""}

${check.dupes.length ? html`
  <div class="card">
    <div class="section-title mb-8">Same phone twice — the later row wins</div>
    ${check.dupes.slice(0, REPORT_LIMIT).map((d) => html`
      <div class="row-sub">${displayPhone(d.kept.phone)}: dropped "${d.dropped.name}", kept "${d.kept.name}"</div>`)}
  </div>` : ""}

${check.toImport.length ? html`
  <div class="card">
    <div class="section-title mb-8">First few</div>
    ${check.toImport.slice(0, 5).map((row) => html`
      <div class="row">
        <div class="row-main">
          <div class="row-title">${row.name}</div>
          <div class="row-sub">${displayPhone(row.phone)} · Tier ${row.tier}${row.niche ? html` · ${row.niche}` : ""}${row.city ? html` · ${row.city}` : ""}</div>
        </div>
      </div>`)}
  </div>

  <form method="POST" action="/import/${batch.id}/commit">
    <button class="btn btn-primary" type="submit">Import ${check.toImport.length} compan${check.toImport.length === 1 ? "y" : "ies"}</button>
  </form>` : html`<div class="card"><div class="empty">Nothing in this file can be imported.</div></div>`}

<form method="POST" action="/import/${batch.id}/discard" class="mt-10">
  <button class="btn btn-secondary" type="submit">Discard</button>
</form>` : ""}

<p class="text-center my-16">
  <a class="tap-link muted" href="/pipeline">Back to pipeline</a>
</p>`;

  return layout({ title: "Import", operator, active: "pipeline", body, flash });
}
