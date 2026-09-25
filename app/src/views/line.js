/* The text-back section of a company's record, and the number picker.

   One card holds the whole delivery story for the business: the number,
   whether it is texting right now and why, whether forwarding is proven, what
   the service has done for them, and the settings -- so the conversation
   about converting a trial happens with the numbers on the same screen. */
import { html } from "../html.js";
import { layout } from "./layout.js";
import { displayPhone, formatDateTime, percent } from "./components.js";
import { formatDate } from "../time.js";
import { conversationRow } from "./inbox.js";
import { languageCodes, languageName, defaultPhrase } from "../delivery/language/index.js";
import { languageModes, lineLanguageMode, LINE_TIMEZONES } from "../delivery/lines.js";
import { ENTITLEMENT_LABELS, TRIAL_GRACE_DAYS } from "../delivery/entitlement.js";
import { EDITABLE_KEYS } from "../delivery/compose.js";

/* Defaults for a new line, from what the record already knows. */
export function newLineDefaults(company, contacts = []) {
  const withPhone = contacts.find((c) => c.phone);
  return {
    display_name: company.name,
    language_mode: "en,es",
    business_number: company.phone,
    alert_phone: withPhone?.phone ?? "",
    alert_language: withPhone?.preferred_language ?? contacts[0]?.preferred_language ?? "es",
    followup_enabled: true,
    followup_delay_minutes: 60,
    daily_send_cap: 200,
    timezone: "America/New_York",
    is_demo: false,
  };
}

export function lineSettingsValues(line) {
  return {
    display_name: line.display_name,
    language_mode: lineLanguageMode(line),
    business_number: line.business_number,
    alert_phone: line.alert_phone,
    alert_language: line.alert_language,
    followup_enabled: line.followup_enabled,
    followup_delay_minutes: line.followup_delay_minutes,
    daily_send_cap: line.daily_send_cap,
    timezone: line.timezone,
    is_demo: line.is_demo,
  };
}

/* The settings fields shared by buying, attaching and editing. `prefix`
   keeps ids unique when two of these forms share a page. */
export function lineSettingsFields(values, prefix = "ls") {
  const id = (name) => `${prefix}-${name}`;
  return html`
<div class="field">
  <label for="${id("name")}">Business name, as it appears in texts</label>
  <input id="${id("name")}" name="display_name" maxlength="60" required value="${values.display_name}">
</div>
<div class="field">
  <label for="${id("mode")}">First text goes out in</label>
  <select id="${id("mode")}" name="language_mode">
    ${languageModes().map((m) => html`
      <option value="${m.value}" ${values.language_mode === m.value ? "selected" : ""}>${m.label}</option>`)}
  </select>
  <div class="field-hint">A customer who has written back before always gets their own language.</div>
</div>
<div class="field-row">
  <div class="field">
    <label for="${id("alert")}">Owner's mobile</label>
    <input id="${id("alert")}" name="alert_phone" type="tel" inputmode="tel" maxlength="20"
           placeholder="+1305…" value="${values.alert_phone}">
  </div>
  <div class="field">
    <label for="${id("alang")}">Owner reads</label>
    <select id="${id("alang")}" name="alert_language">
      ${languageCodes().map((code) => html`
        <option value="${code}" ${values.alert_language === code ? "selected" : ""}>${languageName(code)}</option>`)}
    </select>
  </div>
</div>
<p class="field-hint mb-12">The owner gets a text when a customer replies — not for every missed call.</p>
<div class="field">
  <label for="${id("biz")}">Business number (the one customers dial)</label>
  <input id="${id("biz")}" name="business_number" type="tel" inputmode="tel" maxlength="20"
         value="${values.business_number}">
</div>
<details>
  <summary>Follow-up, limits and time zone</summary>
  <label class="check"><input type="checkbox" name="followup_enabled" ${values.followup_enabled ? "checked" : ""}>
    Send one follow-up if they don't reply</label>
  <div class="field-row">
    <div class="field">
      <label for="${id("delay")}">Follow up after (minutes)</label>
      <input id="${id("delay")}" name="followup_delay_minutes" type="number" inputmode="numeric"
             min="5" max="1440" value="${values.followup_delay_minutes}">
    </div>
    <div class="field">
      <label for="${id("cap")}">Max texts per 24h</label>
      <input id="${id("cap")}" name="daily_send_cap" type="number" inputmode="numeric"
             min="1" max="5000" value="${values.daily_send_cap}">
    </div>
  </div>
  <p class="field-hint mb-12">Follow-ups only go out 8am–8pm on the line's clock.</p>
  <div class="field">
    <label for="${id("tz")}">Time zone</label>
    <select id="${id("tz")}" name="timezone">
      ${LINE_TIMEZONES.map((zone) => html`
        <option value="${zone}" ${values.timezone === zone ? "selected" : ""}>${zone.replace("America/", "").replace("_", " ")}</option>`)}
    </select>
  </div>
  <label class="check"><input type="checkbox" name="is_demo" ${values.is_demo ? "checked" : ""}>
    Demo line — always on, whatever the trial says</label>
</details>`;
}

/* --- the company-page section ---------------------------------------------- */

export function lineSection({ company, contacts, line, entitlement, metrics, window, monthConversations,
                              conversations, templates, preview, provider }) {
  if (!line) return setupCard({ company, contacts, provider });

  const texting = line.status === "active" && (line.is_demo || entitlement.active);
  return html`
<div class="card card-raised" id="line">
  <div class="card-head">
    <span class="section-title">Text-back line</span>
    <span>
      ${line.is_demo ? html`<span class="pill pill-demo">Demo</span> ` : ""}
      <span class="pill pill-${line.status}">${line.status}</span>
    </span>
  </div>

  <div class="line-number">${displayPhone(line.number)}</div>

  ${!provider.enabled ? html`
    <div class="alert alert-error" role="alert">Text-back is switched off on the server: ${provider.reason}</div>` : ""}

  <div class="row-sub ${texting ? "c-success" : "c-warn"}">
    ${texting ? "Texting missed callers now" : "Not texting right now"} ·
    ${line.status === "paused" ? "line paused" : line.is_demo ? "demo line" : entitlementText(entitlement)}
  </div>
  <div class="row-sub">
    ${line.forwarding_verified_at
      ? html`Forwarding verified ${formatDateTime(line.forwarding_verified_at)} · last call ${formatDateTime(line.last_call_at)}`
      : html`<span class="c-warn">No call has reached this number yet</span> — set up forwarding below, then call the business number and let it ring out.`}
  </div>
  ${line.alert_phone ? "" : html`<div class="row-sub c-warn">No owner mobile set — nobody is told when a customer replies.</div>`}

  <div class="section-title mt-14 mb-8">${window.label}</div>
  <div class="stat-grid mb-8">
    <div class="stat"><div class="n">${metrics.missed_calls}</div><div class="l">Missed calls</div></div>
    <div class="stat accent"><div class="n">${metrics.texted}</div><div class="l">Texted back</div></div>
    <div class="stat"><div class="n">${metrics.replies}</div><div class="l">Replies</div></div>
    <div class="stat money"><div class="n">${metrics.leads_captured}</div><div class="l">Leads captured</div></div>
  </div>
  <p class="tiny muted">
    ${metrics.followups_sent} follow-up${metrics.followups_sent === 1 ? "" : "s"}
    (${metrics.replied_after_followup} replied after) ·
    delivered ${percent(metrics.delivered, metrics.texts_sent)} ·
    ${metrics.opt_outs} opt-out${metrics.opt_outs === 1 ? "" : "s"} ·
    ${metrics.segments} SMS segments ·
    ${monthConversations} conversation${monthConversations === 1 ? "" : "s"} this month
  </p>

  ${conversations.length ? html`
    <div class="section-title mt-14">Latest customers</div>
    ${conversations.map((row) => conversationRow(row, { showCompany: false }))}
    <p class="text-center"><a class="tap-link" href="/inbox?company=${company.id}">All conversations</a></p>` : ""}

  <details class="mt-8">
    <summary>Set up forwarding on the business phone</summary>
    ${forwardingInstructions(line)}
  </details>

  <details>
    <summary>Settings</summary>
    <form method="POST" action="/line/${line.id}/settings" class="mt-10">
      ${lineSettingsFields(lineSettingsValues(line), "edit")}
      <button class="btn btn-secondary mt-10" type="submit">Save settings</button>
    </form>
  </details>

  <details>
    <summary>Message wording</summary>
    ${textbackPreview(preview)}
    ${wordingForm(line, templates)}
  </details>

  <div class="btn-row mt-12">
    <form method="POST" action="/line/${line.id}/test">
      <button class="btn btn-secondary btn-sm" type="submit" ${line.status === "active" && line.alert_phone ? "" : "disabled"}>Test text to owner</button>
    </form>
    <form method="POST" action="/line/${line.id}/${line.status === "active" ? "pause" : "resume"}">
      <button class="btn btn-secondary btn-sm" type="submit">${line.status === "active" ? "Pause texting" : "Resume texting"}</button>
    </form>
  </div>

  <details class="mt-8">
    <summary>Release this number</summary>
    <form method="POST" action="/line/${line.id}/release" class="mt-10">
      <p class="small muted mb-10">
        Gives ${displayPhone(line.number)} back to Twilio. Calls forwarded to it stop working and the
        number cannot be got back. The history stays here.
      </p>
      <div class="field">
        <label for="release-confirm">Type the number to confirm</label>
        <input id="release-confirm" name="confirm_number" type="tel" inputmode="tel" required
               placeholder="${displayPhone(line.number)}">
      </div>
      <button class="btn btn-danger btn-sm" type="submit">Release number</button>
    </form>
  </details>
</div>`;
}

function entitlementText(entitlement) {
  const label = ENTITLEMENT_LABELS[entitlement.basis] ?? entitlement.basis;
  if (entitlement.basis === "trial" || entitlement.basis === "converted_pending") {
    return `${label} · ends ${formatDate(entitlement.trial.ends_at)}, texts stop ${TRIAL_GRACE_DAYS} days after`;
  }
  if (entitlement.basis === "grace") {
    return `${label} · texts stop ${formatDateTime(entitlement.graceEnds)} unless converted`;
  }
  return label;
}

function setupCard({ company, contacts, provider }) {
  if (!provider.enabled) {
    return html`
<div class="card" id="line">
  <div class="section-title mb-8">Text-back</div>
  <p class="small muted">Text-back isn't switched on for this server yet: ${provider.reason}</p>
</div>`;
  }
  const areaCode = (company.phone.match(/^\+1(\d{3})/) ?? [])[1] ?? "305";
  return html`
<div class="card" id="line">
  <div class="section-title mb-8">Text-back</div>
  <p class="small mb-12">
    Give ${company.name} its own text-back number. Their business phone forwards missed calls to it,
    and every missed caller gets a text within seconds.
  </p>
  <form method="GET" action="/company/${company.id}/line/numbers">
    <div class="field">
      <label for="area">Area code</label>
      <input id="area" name="area_code" inputmode="numeric" maxlength="3" pattern="[2-9][0-9]{2}"
             required value="${areaCode}">
    </div>
    <button class="btn btn-primary" type="submit">Find a number</button>
  </form>
  <details class="mt-8">
    <summary>Use a number already in Twilio</summary>
    <form method="POST" action="/company/${company.id}/line/attach" class="mt-10">
      <div class="field">
        <label for="attach-number">Twilio number</label>
        <input id="attach-number" name="number" type="tel" inputmode="tel" required placeholder="+1305…">
      </div>
      ${lineSettingsFields(newLineDefaults(company, contacts), "attach")}
      <button class="btn btn-secondary mt-10" type="submit">Attach number</button>
    </form>
  </details>
</div>`;
}

function forwardingInstructions(line) {
  const ten = line.number.replace(/^\+1/, "");
  return html`
<div class="small">
  <p class="mb-10">
    Dial these <strong>from the business phone</strong>${line.business_number ? html` (${displayPhone(line.business_number)})` : ""}
    and press call. Unanswered, busy and unreachable calls then go to ${displayPhone(line.number)}.
  </p>
  <div class="section-title">AT&amp;T, T-Mobile, Cricket, Metro, Mint</div>
  <code class="code">**004*${line.number}#</code>
  <p class="tiny muted mb-10">If it's refused, use <code class="code">**61*${line.number}#</code> for no-answer only. To undo: <strong>##004#</strong></p>
  <div class="section-title">Verizon</div>
  <code class="code">*71${ten}</code>
  <p class="tiny muted mb-10">To undo: <strong>*73</strong></p>
  <div class="section-title">Office or VoIP phone system</div>
  <p class="tiny muted mb-10">Set "forward on no answer" (and busy) to ${displayPhone(line.number)} in the system's settings.</p>
  <p class="tiny muted">Then call the business number from another phone and let it ring out. This card shows
    "Forwarding verified" once the call arrives, and the test phone gets the text.</p>
</div>`;
}

function wordingForm(line, templates) {
  return html`
<form method="POST" action="/line/${line.id}/wording" class="mt-10">
  <p class="small muted mb-10">
    The business name is added automatically. Leave a box as it is to keep the standard wording.
  </p>
  ${EDITABLE_KEYS.map((key) => languageCodes().map((code) => html`
    <div class="field">
      <label for="tpl-${key}-${code}">${key === "textback" ? "First text" : "Follow-up"} · ${languageName(code)}</label>
      <textarea id="tpl-${key}-${code}" name="tpl_${key}_${code}" maxlength="300">${templates.get(`${key}:${code}`) ?? defaultPhrase(code, key)}</textarea>
    </div>`))}
  <button class="btn btn-secondary" type="submit">Save wording</button>
</form>`;
}

/* The first text exactly as a new caller would receive it, with its cost. */
export function textbackPreview({ body, segments, encoding }) {
  return html`
<div class="section-title mt-10 mb-8">A new caller receives</div>
<div class="preview">${body}</div>
<p class="tiny muted mb-10">${segments} SMS segment${segments === 1 ? "" : "s"} (${encoding})</p>`;
}

/* --- number picker --------------------------------------------------------- */

export function numberSearchPage({ operator, company, contacts, areaCode, numbers, error = null, values = null }) {
  const body = html`
<h1>Pick a number</h1>
<p class="muted small mb-12">For ${company.name}</p>

${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ""}

<form method="GET" action="/company/${company.id}/line/numbers" class="card">
  <div class="field">
    <label for="area">Area code</label>
    <input id="area" name="area_code" inputmode="numeric" maxlength="3" pattern="[2-9][0-9]{2}" required value="${areaCode}">
  </div>
  <button class="btn btn-secondary btn-sm" type="submit">Search again</button>
</form>

${numbers.length === 0 ? html`
  <div class="card"><div class="empty">No numbers available in ${areaCode}. Try a nearby area code.</div></div>` : html`
<form method="POST" action="/company/${company.id}/line/provision" class="card">
  <div class="section-title mb-8">Available in ${areaCode}</div>
  <div class="pick-list">
    ${numbers.map((n, index) => html`
      <label class="pick-opt">
        <input type="radio" name="number" value="${n.number}" required ${index === 0 ? "checked" : ""}>
        <span><b>${displayPhone(n.number)}</b><small>${[n.locality, n.region].filter(Boolean).join(", ")}</small></span>
      </label>`)}
  </div>

  ${lineSettingsFields(values ?? newLineDefaults(company, contacts), "buy")}

  <label class="check mt-10"><input type="checkbox" name="confirm" value="yes" required>
    Buy this number. Twilio bills it every month until it's released.</label>
  <button class="btn btn-primary" type="submit">Buy number and go live</button>
</form>`}

<p class="text-center my-16">
  <a class="tap-link muted" href="/company/${company.id}#line">Back to ${company.name}</a>
</p>`;

  return layout({ title: "Pick a number", operator, active: "pipeline", body });
}

