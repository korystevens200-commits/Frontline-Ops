/* The Today screen. Everything here is sized for a thumb. */
import { html } from "../html.js";
import { layout } from "./layout.js";
import {
  displayPhone, statusPill, tierPill, missedCallsBadge, formatDateTime, relativeTime,
} from "./components.js";
import { CLAIM_MINUTES } from "../queue.js";

/* Outcomes needing a second screen are links; the rest submit straight away.
   Order is call-frequency order, and the two that matter most are full width:
   NO ANSWER because it is most of a cold list, SPOKE TO OWNER because it is
   the only one that produces information. */
const SIMPLE = [
  { value: "gatekeeper",     label: "Gatekeeper" },
  { value: "not_interested", label: "Not interested" },
  { value: "dead",           label: "Dead number" },
];

export function todayPage({
  operator, company, counters, callbacksDue, callbacksLater,
  othersClaims, depth, byOperator, flash,
}) {
  const body = html`
<h1>Today</h1>

<div class="counters">
  <div class="counter"><div class="n">${counters.dials}</div><div class="l">Dials</div></div>
  <div class="counter accent"><div class="n">${counters.conversations}</div><div class="l">Convos</div></div>
  <div class="counter win"><div class="n">${counters.trialsInstalled}</div><div class="l">Trials</div></div>
</div>

${byOperator.length > 1 ? html`
  <div class="card">
    <div class="section-title mb-8">Today by caller</div>
    ${byOperator.map((row) => html`
      <div class="row">
        <div class="row-main"><div class="row-title">${row.called_by}</div></div>
        <div class="row-side mono">${row.dials} dials · ${row.conversations} convos</div>
      </div>`)}
  </div>` : ""}

${othersClaims.length ? claimBanners(othersClaims) : ""}

${callbacksDue.length ? html`
  <div class="card">
    <div class="card-head">
      <h2>Callbacks due</h2>
      <span class="pill pill-callback">${callbacksDue.length}</span>
    </div>
    ${callbacksDue.map((cb) => html`
      <div class="row">
        <div class="row-main">
          <div class="row-title"><a href="/company/${cb.id}">${cb.name}</a></div>
          <div class="row-sub">
            Due ${formatDateTime(cb.callback_at)} · set by ${cb.called_by}
            ${cb.missed_calls_per_week !== null ? html` · ${missedCallsBadge(cb.missed_calls_per_week)}` : ""}
          </div>
        </div>
        <div class="row-side">
          <a class="btn btn-secondary btn-sm btn-auto" href="tel:${cb.phone}">Call</a>
        </div>
      </div>`)}
  </div>` : ""}

${company ? dialCard(company) : emptyQueue(depth)}

${callbacksLater.length ? html`
  <div class="card">
    <div class="section-title mb-8">Later today</div>
    ${callbacksLater.map((cb) => html`
      <div class="row">
        <div class="row-main">
          <div class="row-title"><a href="/company/${cb.id}">${cb.name}</a></div>
          <div class="row-sub">${formatDateTime(cb.callback_at)} · ${cb.called_by}</div>
        </div>
      </div>`)}
  </div>` : ""}

<p class="tiny muted text-center mt-14">
  ${depth.total} left in the cold queue · ${depth.A} Tier A · ${depth.B} Tier B
</p>`;

  return layout({ title: "Today", operator, active: "today", body, flash });
}

/* Who else is holding what. Capped at two banners: with a second caller there
   is only ever one, but nothing should be able to push the dial card below the
   fold, which is what a stack of these does. */
function claimBanners(claims) {
  const shown = claims.slice(0, 2);
  const rest = claims.length - shown.length;
  return html`
${shown.map((claim) => html`
  <div class="claim">
    <span class="claim-dot" aria-hidden="true"></span>
    <span><strong>${claim.claimed_by}</strong> is on ${claim.name}</span>
  </div>`)}
${rest > 0 ? html`
  <div class="claim">
    <span class="claim-dot" aria-hidden="true"></span>
    <span>+${rest} more held by others</span>
  </div>` : ""}`;
}

function dialCard(company) {
  return html`
<div class="card card-raised">
  <div class="claim mine">
    <span class="claim-dot" aria-hidden="true"></span>
    <span>Yours for ${CLAIM_MINUTES} minutes</span>
  </div>

  <div class="dial-name">${company.name}</div>
  <div class="dial-meta">
    ${tierPill(company.tier)} ${statusPill(company.status)}
    ${company.niche ? html` ${company.niche}` : ""}
  </div>
  ${company.address || company.city ? html`
    <div class="dial-meta">${[company.address, company.city, company.zip].filter(Boolean).join(", ")}</div>` : ""}
  ${company.google_rating !== null ? html`
    <div class="dial-meta">${company.google_rating}★ · ${company.review_count ?? 0} reviews</div>` : ""}
  ${company.last_called_at ? html`
    <div class="dial-meta">Last called ${relativeTime(company.last_called_at)} · ${company.call_count} call${company.call_count === 1 ? "" : "s"}</div>` : ""}
  ${company.notes ? html`<div class="small mt-8">${company.notes}</div>` : ""}

  <a class="tel" href="tel:${company.phone}">${displayPhone(company.phone)}</a>

  <div class="outcomes">
    <form method="POST" action="/today/outcome" class="contents">
      <input type="hidden" name="company_id" value="${company.id}">
      <button class="outcome o-no_answer wide" type="submit" name="outcome" value="no_answer">
        No answer
      </button>
    </form>

    <a class="outcome o-spoke_to_owner wide"
       href="/today/log?company=${company.id}&outcome=spoke_to_owner">Spoke to owner</a>

    <a class="outcome o-callback"
       href="/today/log?company=${company.id}&outcome=callback">Callback</a>
    <a class="outcome o-trial_agreed"
       href="/today/log?company=${company.id}&outcome=trial_agreed">Trial agreed</a>

    <form method="POST" action="/today/outcome" class="contents">
      <input type="hidden" name="company_id" value="${company.id}">
      ${SIMPLE.map((o) => html`
        <button class="outcome o-${o.value}" type="submit" name="outcome" value="${o.value}">
          ${o.label}
        </button>`)}
    </form>
  </div>

  <p class="tiny muted text-center mt-10">
    <a class="tap-link" href="/company/${company.id}">Open full record</a>
  </p>
</div>`;
}

function emptyQueue(depth) {
  return html`
<div class="card">
  <div class="empty">
    ${depth.total === 0
      ? html`<strong>Queue is empty.</strong><br>Every company has been worked through.
             Import more prospects to keep going.`
      : html`<strong>Nothing free right now.</strong><br>
             The remaining ${depth.total} are held by someone else. Holds expire after ${CLAIM_MINUTES} minutes.`}
  </div>
</div>`;
}

/* Second screen for the outcomes that carry data. Separate page rather than an
   inline reveal: on a phone it puts the field you must fill under your thumb
   with nothing else competing for the tap. */
export function logDetailPage({ operator, company, outcome, values = {}, error = null }) {
  const heading = {
    spoke_to_owner: "Spoke to owner",
    callback: "Book a callback",
    trial_agreed: "Trial agreed",
  }[outcome];

  const body = html`
<h1>${heading}</h1>
<p class="muted small mb-14">${company.name} · ${displayPhone(company.phone)}</p>

${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ""}

<form method="POST" action="/today/log" class="card">
  <input type="hidden" name="company_id" value="${company.id}">
  <input type="hidden" name="outcome" value="${outcome}">

  ${outcome === "spoke_to_owner" ? html`
    <div class="field-critical">
      <label for="mcw">Missed calls per week</label>
      <input id="mcw" name="missed_calls_per_week" type="number" inputmode="numeric"
             min="0" max="500" step="1" required autofocus
             value="${values.missed_calls_per_week ?? ""}">
      <div class="field-hint">Under 4 and they are not a fit — disqualify and move on.</div>
    </div>

    <div class="field">
      <label for="objection">Objection</label>
      <input id="objection" name="objection" maxlength="300"
             placeholder="Price, already have someone, not interested…"
             value="${values.objection ?? ""}">
    </div>` : ""}

  ${outcome === "callback" ? html`
    <div class="field">
      <label for="callback_at">Call them back at</label>
      <input id="callback_at" name="callback_at" type="datetime-local" required autofocus
             value="${values.callback_at ?? ""}">
      <div class="field-hint">Eastern time. Shows on Today when it comes due.</div>
    </div>

    <div class="field">
      <label for="objection">Objection or reason</label>
      <input id="objection" name="objection" maxlength="300" value="${values.objection ?? ""}">
    </div>` : ""}

  ${outcome === "trial_agreed" ? html`
    <div class="field">
      <label for="mcw2">Missed calls per week <span class="muted">(if you got it)</span></label>
      <input id="mcw2" name="missed_calls_per_week" type="number" inputmode="numeric"
             min="0" max="500" step="1" value="${values.missed_calls_per_week ?? ""}">
    </div>
    <p class="small muted mb-12">
      Opens a 14-day trial starting now, installed by ${operator}.
    </p>` : ""}

  <div class="field">
    <label for="notes">Notes</label>
    <textarea id="notes" name="notes" maxlength="4000"
              placeholder="What they said, who to ask for, when they're around…">${values.notes ?? ""}</textarea>
  </div>

  <button class="btn btn-primary" type="submit">Save &amp; next</button>
  <p class="text-center mt-12">
    <a class="tap-link muted" href="/today">Cancel</a>
  </p>
</form>`;

  return layout({ title: heading, operator, active: "today", body });
}
