import { html } from "../html.js";
import { layout } from "./layout.js";
import {
  displayPhone, statusPill, tierPill, missedCallsBadge, callRow, money,
  formatDateTime, relativeTime, OUTCOMES, COMPANY_STATUSES, STATUS_LABELS,
} from "./components.js";
import { toLocalInputValue } from "../time.js";

export function companyPage({
  operator, company, contacts, calls, trials, client, payments, activity, flash, error,
}) {
  const body = html`
<h1>${company.name}</h1>
<p class="muted small mb-12">
  ${tierPill(company.tier)} ${statusPill(company.status)}
  ${company.niche ? html` ${company.niche}` : ""}
</p>

${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ""}

<a class="tel" href="tel:${company.phone}">${displayPhone(company.phone)}</a>

<div class="card">
  <div class="section-title mb-8">Details</div>
  ${company.address || company.city ? html`
    <div class="row-sub">${[company.address, company.city, company.zip].filter(Boolean).join(", ")}</div>` : ""}
  ${company.google_rating !== null ? html`
    <div class="row-sub">${company.google_rating}★ · ${company.review_count ?? 0} reviews</div>` : ""}
  <div class="row-sub">Source: ${company.source} · imported ${formatDateTime(company.created_at)}</div>
  ${calls.length ? html`
    <div class="row-sub">${calls.length} call${calls.length === 1 ? "" : "s"} · last ${relativeTime(calls[0].called_at)}</div>` : html`
    <div class="row-sub">Never called</div>`}
</div>

${client ? clientCard(client, payments) : ""}
${trials.length ? trialsCard(trials, client) : ""}

<div class="card">
  <div class="section-title mb-10">Log a call</div>
  <form method="POST" action="/company/${company.id}/call">
    <div class="field">
      <label for="outcome">Outcome</label>
      <select id="outcome" name="outcome" required>
        ${OUTCOMES.map((o) => html`<option value="${o.value}">${o.label}</option>`)}
      </select>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="mcw">Missed calls/week</label>
        <input id="mcw" name="missed_calls_per_week" type="number" inputmode="numeric"
               min="0" max="500" step="1" placeholder="Required if you spoke to the owner">
      </div>
      <div class="field">
        <label for="cb">Callback at</label>
        <input id="cb" name="callback_at" type="datetime-local">
      </div>
    </div>
    <div class="field">
      <label for="obj">Objection</label>
      <input id="obj" name="objection" maxlength="300">
    </div>
    <div class="field">
      <label for="cnotes">Notes</label>
      <textarea id="cnotes" name="notes" maxlength="4000"></textarea>
    </div>
    <button class="btn btn-primary" type="submit">Log call</button>
  </form>
</div>

<div class="card">
  <div class="card-head">
    <span class="section-title">Call history</span>
    <span class="tiny muted">${calls.length}</span>
  </div>
  ${calls.length === 0
    ? html`<div class="empty">No calls yet.</div>`
    : calls.map((call) => callRow(call))}
</div>

<div class="card">
  <div class="section-title mb-10">Contacts</div>
  ${contacts.length === 0 ? html`<p class="small muted">No contacts yet.</p>` : contacts.map((contact) => html`
    <div class="row">
      <div class="row-main">
        <div class="row-title">${contact.name}${contact.role ? html` <span class="muted small">· ${contact.role}</span>` : ""}</div>
        <div class="row-sub">
          ${contact.phone ? html`<a href="tel:${contact.phone}">${displayPhone(contact.phone)}</a> · ` : ""}
          ${contact.preferred_language === "es" ? "Español" : "English"}
        </div>
        ${contact.notes ? html`<div class="row-sub">${contact.notes}</div>` : ""}
      </div>
      <div class="row-side">
        <form method="POST" action="/company/${company.id}/contact/${contact.id}/delete">
          <button class="linkbtn" type="submit">Remove</button>
        </form>
      </div>
    </div>`)}

  <details class="mt-12">
    <summary>Add a contact</summary>
    <form method="POST" action="/company/${company.id}/contact" class="mt-10">
      <div class="field-row">
        <div class="field">
          <label for="cname">Name</label>
          <input id="cname" name="name" required maxlength="120">
        </div>
        <div class="field">
          <label for="crole">Role</label>
          <input id="crole" name="role" maxlength="80" placeholder="Owner, manager…">
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="cphone">Phone</label>
          <input id="cphone" name="phone" type="tel" maxlength="40" placeholder="+1305…">
        </div>
        <div class="field">
          <label for="clang">Language</label>
          <select id="clang" name="preferred_language">
            <option value="es">Español</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label for="cnote">Notes</label>
        <input id="cnote" name="notes" maxlength="500">
      </div>
      <button class="btn btn-secondary" type="submit">Add contact</button>
    </form>
  </details>
</div>

<div class="card">
  <div class="section-title mb-10">Company notes &amp; status</div>
  <form method="POST" action="/company/${company.id}/notes">
    <div class="field">
      <label for="status">Status</label>
      <select id="status" name="status">
        ${COMPANY_STATUSES.map((s) => html`
          <option value="${s}" ${company.status === s ? "selected" : ""}>${STATUS_LABELS[s]}</option>`)}
      </select>
    </div>
    <div class="field">
      <label for="notes">Notes</label>
      <textarea id="notes" name="notes" maxlength="4000">${company.notes}</textarea>
    </div>
    <button class="btn btn-secondary" type="submit">Save</button>
  </form>
</div>

${!client ? html`
<div class="card">
  <div class="section-title mb-10">Convert to paying client</div>
  <form method="POST" action="/company/${company.id}/client">
    <div class="field-row">
      <div class="field">
        <label for="rate">Monthly rate</label>
        <input id="rate" name="monthly_rate" inputmode="decimal" value="297" required>
      </div>
      <div class="field">
        <label for="setup">Setup fee</label>
        <input id="setup" name="setup_fee" inputmode="decimal" value="0" required>
      </div>
    </div>
    <div class="field">
      <label for="plan">Plan</label>
      <input id="plan" name="plan" maxlength="80" value="missed_call_textback">
    </div>
    <button class="btn btn-primary" type="submit">Start client</button>
  </form>
</div>` : ""}

<div class="card">
  <div class="card-head"><span class="section-title">Activity</span></div>
  ${activity.length === 0 ? html`<p class="small muted">Nothing logged yet.</p>` : activity.map((entry) => html`
    <div class="callrow">
      <div class="row-sub">${entry.actor} · ${entry.action} · ${formatDateTime(entry.created_at)}</div>
      ${entry.detail ? html`<div class="small">${entry.detail}</div>` : ""}
    </div>`)}
</div>

<p class="text-center my-16">
  <a class="tap-link muted" href="/pipeline">Back to pipeline</a>
</p>`;

  return layout({ title: company.name, operator, active: "pipeline", body, flash });
}

function trialsCard(trials, client) {
  return html`
<div class="card">
  <div class="section-title mb-10">Trials</div>
  ${trials.map((trial) => html`
    <div class="row">
      <div class="row-main">
        <div class="row-title">
          <span class="pill pill-${trial.status}">${trial.status}</span>
        </div>
        <div class="row-sub">
          ${formatDateTime(trial.started_at)} → ${formatDateTime(trial.ends_at)}
          ${trial.installed_by ? html` · installed by ${trial.installed_by}` : ""}
        </div>
        ${trial.notes ? html`<div class="row-sub">${trial.notes}</div>` : ""}
      </div>
    </div>
    ${trial.status === "active" ? html`
      <form method="POST" action="/trial/${trial.id}/status" class="mt-10">
        <div class="field">
          <label for="ts${trial.id}">Update trial</label>
          <select id="ts${trial.id}" name="status">
            <option value="converted">Converted${client ? "" : " (start a client below)"}</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <button class="btn btn-secondary btn-sm" type="submit">Save</button>
      </form>` : ""}`)}
</div>`;
}

function clientCard(client, payments) {
  const collected = payments.reduce((sum, p) => sum + p.amount, 0);
  return html`
<div class="card card-raised">
  <div class="card-head">
    <span class="section-title">Client</span>
    <span class="pill pill-${client.status}">${client.status}</span>
  </div>
  <div class="stat-grid mb-12">
    <div class="stat money"><div class="n">${money(client.monthly_rate)}</div><div class="l">Per month</div></div>
    <div class="stat"><div class="n">${money(client.setup_fee)}</div><div class="l">Setup fee</div></div>
  </div>
  <div class="row-sub">Started ${formatDateTime(client.started_at)} · ${client.plan}</div>
  <div class="row-sub">Setup ${client.setup_paid ? "paid" : "unpaid"} · ${money(collected)} collected</div>
  ${client.churned_at ? html`
    <div class="row-sub">Churned ${formatDateTime(client.churned_at)}${client.churn_reason ? html` — ${client.churn_reason}` : ""}</div>` : ""}

  <details class="mt-12">
    <summary>Payments (${payments.length})</summary>
    ${payments.map((p) => html`
      <div class="row">
        <div class="row-main">
          <div class="row-title">${money(p.amount)} <span class="pill">${p.kind}</span></div>
          <div class="row-sub">${formatDateTime(p.paid_at)}${p.notes ? html` · ${p.notes}` : ""}</div>
        </div>
      </div>`)}
    <form method="POST" action="/client/${client.id}/payment" class="mt-10">
      <div class="field-row">
        <div class="field">
          <label for="amt">Amount</label>
          <input id="amt" name="amount" inputmode="decimal" required placeholder="297">
        </div>
        <div class="field">
          <label for="kind">Kind</label>
          <select id="kind" name="kind">
            <option value="monthly">Monthly</option>
            <option value="setup">Setup</option>
          </select>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm" type="submit">Record payment</button>
    </form>
  </details>

  ${client.status === "active" ? html`
    <details class="mt-8">
      <summary>Mark churned</summary>
      <form method="POST" action="/client/${client.id}/churn" class="mt-10">
        <div class="field">
          <label for="reason">Reason</label>
          <input id="reason" name="churn_reason" maxlength="300" required>
        </div>
        <button class="btn btn-danger btn-sm" type="submit">Mark churned</button>
      </form>
    </details>` : ""}
</div>`;
}
