/* Inbox and conversation screens: every customer who called a client's line,
   and what was said. */
import { html, queryString } from "../html.js";
import { layout } from "./layout.js";
import { displayPhone, formatDateTime, relativeTime } from "./components.js";
import { languageName } from "../delivery/language/index.js";

export const INBOX_VIEWS = [
  { value: "",           label: "All" },
  { value: "needs_reply", label: "Needs reply" },
  { value: "waiting",    label: "Texted, no reply" },
  { value: "closed",     label: "Closed" },
  { value: "opted_out",  label: "Opted out" },
];

const STATUS_LABELS = { open: "Texted", replied: "New reply", closed: "Closed" };

export function conversationPill(conversation) {
  if (conversation.opted_out_at) return html`<span class="pill pill-optout">Opted out</span>`;
  return html`<span class="pill pill-${conversation.status}">${STATUS_LABELS[conversation.status] ?? conversation.status}</span>`;
}

/* Carrier errors worth a plain-English name, because they change what the
   owner should do next. */
const ERROR_LABELS = {
  30003: "phone unreachable",
  30005: "number doesn't exist",
  30006: "landline — call them instead",
  30007: "blocked by the carrier as spam",
  30008: "carrier error",
  21610: "they opted out",
  21211: "invalid number",
  21614: "not a mobile number",
};

export function errorLabel(code) {
  return ERROR_LABELS[code] ?? (code ? `error ${code}` : "");
}

const MESSAGE_KIND_LABELS = {
  textback: "Text-back",
  followup: "Follow-up",
  optout_confirm: "Opt-out confirmation",
  owner_alert: "Owner alert",
  test: "Test",
};

const DELIVERY_LABELS = {
  queued: "Queued",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  undelivered: "Not delivered",
  failed: "Failed",
  unknown: "Unconfirmed",
  cancelled: "Not sent",
};

function deliveryLine(message) {
  const bits = [MESSAGE_KIND_LABELS[message.kind] ?? message.kind, DELIVERY_LABELS[message.status] ?? message.status];
  if (message.error_code) bits.push(errorLabel(message.error_code));
  else if (message.status === "cancelled" && message.error_message) bits.push(message.error_message);
  return bits.join(" · ");
}

export function inboxPage({ operator, rows, view, company, page, pages, counts, flash }) {
  const link = (params) => `/inbox${queryString({ view, company: company?.id, ...params })}`;
  const body = html`
<h1>Inbox</h1>
${company ? html`
  <p class="muted small mb-10">
    Showing ${company.name} only · <a href="${`/inbox${queryString({ view })}`}">show everyone</a>
  </p>` : ""}

<nav class="chips" aria-label="Filter">
  ${INBOX_VIEWS.map((v) => html`
    <a class="chip ${view === v.value ? "active" : ""}" href="${link({ view: v.value, page: null })}">
      ${v.label}${v.value === "needs_reply" && counts.needs_reply ? html` <span class="c-pink">${counts.needs_reply}</span>` : ""}
    </a>`)}
</nav>

<div class="card">
  ${rows.length === 0
    ? html`<div class="empty">${emptyMessage(view)}</div>`
    : rows.map((row) => conversationRow(row, { showCompany: !company }))}
</div>

${pages > 1 ? html`
<div class="row row-split">
  ${page > 1
    ? html`<a class="btn btn-secondary btn-sm btn-auto" href="${link({ page: page - 1 })}">Previous</a>`
    : html`<span></span>`}
  <span class="tiny muted">Page ${page} of ${pages}</span>
  ${page < pages
    ? html`<a class="btn btn-secondary btn-sm btn-auto" href="${link({ page: page + 1 })}">Next</a>`
    : html`<span></span>`}
</div>` : ""}`;

  return layout({ title: "Inbox", operator, active: "inbox", body, flash });
}

function emptyMessage(view) {
  return {
    needs_reply: "No replies waiting. Every customer who wrote back has been handled.",
    waiting: "Nobody is waiting on a reply to a text-back.",
    closed: "No closed conversations yet.",
    opted_out: "Nobody has opted out.",
  }[view] ?? "No conversations yet. They appear here when a missed call reaches a client's line.";
}

export function conversationRow(row, { showCompany = true } = {}) {
  const prefix = row.last_direction === "inbound" ? "" : "↪ ";
  return html`
<div class="row ${row.status === "replied" && !row.opted_out_at ? "needs-reply" : ""}">
  <div class="row-main">
    <div class="row-title"><a href="/conversation/${row.id}">${displayPhone(row.lead_phone)}</a></div>
    <div class="row-sub">
      ${showCompany ? html`${row.company_name} · ` : ""}${relativeTime(row.last_activity_at)}
      ${row.call_count ? html` · ${row.call_count} call${row.call_count === 1 ? "" : "s"}` : ""}
      ${row.is_demo ? html` · <span class="c-pink">demo line</span>` : ""}
    </div>
    ${row.last_body ? html`<div class="snippet">${prefix}${truncate(row.last_body, 90)}</div>` : ""}
    ${row.last_error ? html`<div class="row-sub c-danger">${errorLabel(row.last_error)}</div>` : ""}
  </div>
  <div class="row-side">${conversationPill(row)}</div>
</div>`;
}

function truncate(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const DECISION_NOTES = {
  texted: { text: "texted back", tone: "good" },
  duplicate: { text: "already texted recently — not texted again", tone: "" },
  opted_out: { text: "not texted — they opted out", tone: "bad" },
  not_entitled: { text: "not texted — trial over", tone: "bad" },
  paused: { text: "not texted — line paused", tone: "bad" },
  no_caller_id: { text: "no caller ID — can't text", tone: "bad" },
  spam_suspected: { text: "caller ID failed verification — not texted", tone: "bad" },
  cap_reached: { text: "not texted — daily limit reached", tone: "bad" },
};

export function conversationPage({ operator, conversation, events, flash }) {
  const body = html`
<h1>${displayPhone(conversation.lead_phone)}</h1>
<p class="muted small mb-10">
  <a href="/company/${conversation.company_id}">${conversation.company_name}</a>
  · line ${displayPhone(conversation.line_number)}
  ${conversation.language ? html` · ${languageName(conversation.language)}` : ""}
  ${conversation.is_demo ? html` · <span class="c-pink">demo line</span>` : ""}
</p>
<p class="mb-10">${conversationPill(conversation)}</p>

${conversation.opted_out_at ? html`
  <div class="alert alert-warn" role="status">
    Opted out ${formatDateTime(conversation.opted_out_at)}. No more automated texts go to this number.
    Calling them is still fine.
  </div>` : ""}

<a class="tel" href="tel:${conversation.lead_phone}">Call ${displayPhone(conversation.lead_phone)}</a>

<div class="card">
  <div class="section-title mb-10">Conversation</div>
  <div class="thread">
    ${events.length === 0 ? html`<div class="empty">Nothing yet.</div>` : events.map(threadItem)}
  </div>
</div>

<div class="card">
  <form method="POST" action="/conversation/${conversation.id}/status">
    ${conversation.status === "closed" ? html`
      <input type="hidden" name="status" value="open">
      <p class="small muted mb-10">Closed ${formatDateTime(conversation.closed_at)}${conversation.closed_by ? html` by ${conversation.closed_by}` : ""}.</p>
      <button class="btn btn-secondary" type="submit">Reopen</button>` : html`
      <input type="hidden" name="status" value="closed">
      <button class="btn btn-primary" type="submit">Mark handled</button>
      <p class="tiny muted mt-8">Takes it out of "Needs reply". It reopens by itself if they call or text again.</p>`}
  </form>
</div>

<p class="text-center my-16">
  <a class="tap-link muted" href="/inbox">Back to inbox</a>
</p>`;

  return layout({ title: displayPhone(conversation.lead_phone), operator, active: "inbox", body, flash });
}

function threadItem(event) {
  if (event.type === "call") {
    const note = DECISION_NOTES[event.decision] ?? { text: event.decision, tone: "" };
    return html`<div class="sys-note ${note.tone}">Missed call · ${formatDateTime(event.at)} · ${note.text}</div>`;
  }
  const message = event.message;
  if (message.kind === "owner_alert") {
    return html`<div class="sys-note ${message.status === "failed" || message.status === "undelivered" ? "bad" : ""}">
      Owner alerted at ${displayPhone(message.to_number)} · ${DELIVERY_LABELS[message.status] ?? message.status}
      ${message.error_code ? html` · ${errorLabel(message.error_code)}` : ""} · ${formatDateTime(event.at)}
    </div>`;
  }
  if (message.direction === "inbound") {
    const kindNote = message.kind === "optout" ? " · opted out" : message.kind === "optin" ? " · opted back in" : "";
    return html`
<div class="bubble bubble-in">${message.body || (message.media_count ? "(photo)" : "")}<span class="bubble-meta">${formatDateTime(event.at)}${kindNote}${message.media_count ? html` · ${message.media_count} attachment${message.media_count === 1 ? "" : "s"}` : ""}</span></div>`;
  }
  const failed = message.status === "failed" || message.status === "undelivered";
  return html`
<div class="bubble bubble-out ${failed ? "bubble-failed" : ""}">${message.body}<span class="bubble-meta">${deliveryLine(message)} · ${formatDateTime(event.at)}</span></div>`;
}
