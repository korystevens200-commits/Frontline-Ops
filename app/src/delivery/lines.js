/* A client's line: provisioning, settings, wording, pause, release.

   Every change is written with its activity_log rows in one transaction --
   against the company (so it shows on the company's record) and against the
   line. Provider calls happen outside the transaction, because they cannot
   be rolled back; where one succeeds and the write after it fails, the code
   undoes the provider side rather than leave a number billing monthly that
   the app does not know it owns. */
import { one, tx } from "../db.js";
import { logActivity } from "../activity.js";
import { ValidationError, normalizePhone, requireString, optionalInt } from "../validate.js";
import { isTextableUsNumber, ProviderError } from "../providers/common.js";
import { hasLanguage, languageCodes, languageName, defaultPhrase } from "./language/index.js";
import { EDITABLE_KEYS } from "./compose.js";
import { enqueueMessage } from "./outbox.js";
import { isValidZone } from "../time.js";

export const LINE_TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
];

/* The first-text language choices offered in forms: every single language,
   and every ordered pair. With a third language this grows by itself. */
export function languageModes() {
  const codes = languageCodes();
  const modes = [];
  for (const first of codes) {
    for (const second of codes) {
      if (first !== second) {
        modes.push({ value: `${first},${second}`, label: `${languageName(first)}, then ${languageName(second)}` });
      }
    }
  }
  for (const code of codes) modes.push({ value: code, label: `${languageName(code)} only` });
  return modes;
}

export function lineLanguageMode(line) {
  return [line.primary_language, line.secondary_language].filter(Boolean).join(",");
}

export async function liveLineForCompany(handle, companyId) {
  return handle.one(
    `SELECT * FROM lines WHERE company_id = $1 AND status <> 'released' ORDER BY id DESC LIMIT 1`,
    [companyId]
  );
}

/* Map of "key:language" -> body for this line's reworded text. */
export async function lineTemplates(handle, lineId) {
  const rows = await handle.query(
    `SELECT key, language, body FROM line_templates WHERE line_id = $1`, [lineId]
  );
  return new Map(rows.map((row) => [`${row.key}:${row.language}`, row.body]));
}

/* --- settings -------------------------------------------------------------- */

/* Validate the settings form shared by provisioning, attaching and editing. */
export function parseLineSettings(body = {}) {
  const displayName = requireString(body.display_name, "Business name as texted", { max: 60 });

  const mode = String(body.language_mode ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (mode.length < 1 || mode.length > 2 || !mode.every(hasLanguage) || new Set(mode).size !== mode.length) {
    throw new ValidationError("Choose which language the first text goes out in.", "language_mode");
  }

  const alertLanguage = String(body.alert_language ?? "");
  if (!hasLanguage(alertLanguage)) throw new ValidationError("Choose the owner's language.", "alert_language");

  const phoneOrEmpty = (value, label) => {
    const text = String(value ?? "").trim();
    if (!text) return "";
    const phone = normalizePhone(text);
    if (!phone || !isTextableUsNumber(phone)) throw new ValidationError(`${label} is not a valid US number.`, label);
    return phone;
  };

  const timezone = String(body.timezone ?? "America/New_York");
  if (!LINE_TIMEZONES.includes(timezone) || !isValidZone(timezone)) {
    throw new ValidationError("Choose a time zone from the list.", "timezone");
  }

  return {
    display_name: displayName,
    business_number: phoneOrEmpty(body.business_number, "Business number"),
    alert_phone: phoneOrEmpty(body.alert_phone, "Owner's mobile"),
    alert_language: alertLanguage,
    primary_language: mode[0],
    secondary_language: mode[1] ?? null,
    followup_enabled: body.followup_enabled === "on" || body.followup_enabled === "true",
    followup_delay_minutes: optionalInt(body.followup_delay_minutes, "Follow-up delay (minutes)", { min: 5, max: 1440 }) ?? 60,
    daily_send_cap: optionalInt(body.daily_send_cap, "Daily text limit", { min: 1, max: 5000 }) ?? 200,
    timezone,
    is_demo: body.is_demo === "on" || body.is_demo === "true",
  };
}

const SETTING_COLUMNS = [
  "display_name", "business_number", "alert_phone", "alert_language", "primary_language",
  "secondary_language", "followup_enabled", "followup_delay_minutes", "daily_send_cap", "timezone", "is_demo",
];

async function insertLine(handle, { company, number, sid, provider, messagingServiceSid, settings, operator, how }) {
  const line = await handle.one(
    `INSERT INTO lines
       (company_id, number, provider, provider_number_sid, messaging_service_sid, created_by,
        ${SETTING_COLUMNS.join(", ")})
     VALUES ($1, $2, $3, $4, $5, $6, ${SETTING_COLUMNS.map((_, i) => `$${i + 7}`).join(", ")})
     RETURNING *`,
    [company.id, number, provider, sid, messagingServiceSid, operator,
     ...SETTING_COLUMNS.map((column) => settings[column])]
  );
  const detail = `${number}${settings.is_demo ? " (demo line)" : ""} — ${how}`;
  await logActivity(handle, { actor: operator, entityType: "company", entityId: company.id, action: "line_created", detail });
  await logActivity(handle, { actor: operator, entityType: "line", entityId: line.id, action: "line_created", detail });
  return line;
}

async function requireCompanyWithoutLine(companyId) {
  const company = await one(`SELECT * FROM companies WHERE id = $1`, [companyId]);
  if (!company) throw new ValidationError("That company no longer exists.");
  const existing = await liveLineForCompany({ one }, companyId);
  if (existing) throw new ValidationError("This company already has a text-back line.");
  return company;
}

/* Buy a number and make it this company's line. Costs money: the route asks
   for an explicit confirmation before calling this. */
export async function provisionLine({ provider, companyId, number, settings, operator, log = null }) {
  const company = await requireCompanyWithoutLine(companyId);
  if (!isTextableUsNumber(number)) throw new ValidationError("Pick a number from the search results.");

  const purchased = await provider.purchaseNumber({ number, friendlyName: `Frontline Ops · ${settings.display_name}` });
  try {
    const service = provider.defaultMessagingServiceSid;
    if (service) await provider.addToMessagingService(purchased.sid, service);
    return await tx((handle) => insertLine(handle, {
      company, number: purchased.number, sid: purchased.sid, provider: provider.name,
      messagingServiceSid: "", settings, operator, how: "number bought",
    }));
  } catch (err) {
    /* Bought but not saved: give the number back rather than leave it
       billing with nothing pointing at it. */
    try {
      await provider.releaseNumber(purchased.sid);
    } catch (releaseErr) {
      log?.error({ sid: purchased.sid, err: releaseErr }, "bought a number, could not save or release it");
      throw new ValidationError(
        `Bought ${purchased.number} but could not save it, and could not release it either. ` +
        `Release it in the Twilio console. (${err.message})`
      );
    }
    throw err;
  }
}

/* Use a number already in the Twilio account: point its webhooks here. */
export async function attachLine({ provider, companyId, number, settings, operator }) {
  const company = await requireCompanyWithoutLine(companyId);
  const phone = normalizePhone(number);
  if (!phone || !isTextableUsNumber(phone)) throw new ValidationError("That is not a valid US number.", "number");

  const clash = await one(`SELECT id FROM lines WHERE number = $1 AND status <> 'released'`, [phone]);
  if (clash) throw new ValidationError("That number is already another company's line.", "number");

  const found = await provider.findNumber(phone);
  if (!found) throw new ValidationError("That number is not in the Twilio account.", "number");
  await provider.configureNumber(found.sid, { friendlyName: `Frontline Ops · ${settings.display_name}` });
  const service = provider.defaultMessagingServiceSid;
  if (service) await provider.addToMessagingService(found.sid, service);

  return tx((handle) => insertLine(handle, {
    company, number: found.number, sid: found.sid, provider: provider.name,
    messagingServiceSid: "", settings, operator, how: "existing number attached",
  }));
}

export async function updateLineSettings({ lineId, settings, operator }) {
  return tx(async (handle) => {
    const before = await handle.one(`SELECT * FROM lines WHERE id = $1 FOR UPDATE`, [lineId]);
    if (!before || before.status === "released") throw new ValidationError("That line no longer exists.");
    const changed = SETTING_COLUMNS.filter((column) => String(before[column] ?? "") !== String(settings[column] ?? ""));
    if (changed.length === 0) return before;

    const after = await handle.one(
      `UPDATE lines SET ${SETTING_COLUMNS.map((column, i) => `${column} = $${i + 2}`).join(", ")}
        WHERE id = $1 RETURNING *`,
      [lineId, ...SETTING_COLUMNS.map((column) => settings[column])]
    );
    const detail = `changed ${changed.join(", ")}`;
    await logActivity(handle, { actor: operator, entityType: "line", entityId: lineId, action: "line_settings_updated", detail });
    await logActivity(handle, { actor: operator, entityType: "company", entityId: before.company_id, action: "line_settings_updated", detail });
    return after;
  });
}

/* Form fields named tpl_<key>_<language>. A body left equal to the default,
   or emptied, removes the override so future default improvements apply. */
export async function saveLineTemplates({ lineId, body, operator }) {
  return tx(async (handle) => {
    const line = await handle.one(`SELECT * FROM lines WHERE id = $1 FOR UPDATE`, [lineId]);
    if (!line || line.status === "released") throw new ValidationError("That line no longer exists.");
    const changes = [];
    for (const key of EDITABLE_KEYS) {
      for (const language of languageCodes()) {
        const field = `tpl_${key}_${language}`;
        if (!(field in body)) continue;
        const text = String(body[field] ?? "").replace(/\s+/g, " ").trim();
        if (text.length > 300) throw new ValidationError(`${languageName(language)} ${key} text must be 300 characters or fewer.`);
        if (!text || text === defaultPhrase(language, key)) {
          const removed = await handle.query(
            `DELETE FROM line_templates WHERE line_id = $1 AND key = $2 AND language = $3 RETURNING 1`,
            [lineId, key, language]
          );
          if (removed.length) changes.push(`${key}/${language} reset`);
        } else {
          const saved = await handle.one(
            `INSERT INTO line_templates (line_id, key, language, body, updated_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (line_id, key, language) DO UPDATE
               SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()
               WHERE line_templates.body <> EXCLUDED.body
             RETURNING 1`,
            [lineId, key, language, text, operator]
          );
          if (saved) changes.push(`${key}/${language}`);
        }
      }
    }
    if (changes.length) {
      const detail = `wording: ${changes.join(", ")}`;
      await logActivity(handle, { actor: operator, entityType: "line", entityId: lineId, action: "line_wording_updated", detail });
      await logActivity(handle, { actor: operator, entityType: "company", entityId: line.company_id, action: "line_wording_updated", detail });
    }
    return changes;
  });
}

export async function setLineStatus({ lineId, status, operator }) {
  if (status !== "active" && status !== "paused") throw new ValidationError("Unknown line status.");
  return tx(async (handle) => {
    const line = await handle.one(`SELECT * FROM lines WHERE id = $1 FOR UPDATE`, [lineId]);
    if (!line || line.status === "released") throw new ValidationError("That line no longer exists.");
    if (line.status === status) return line;
    const updated = await handle.one(
      `UPDATE lines SET status = $2, paused_at = CASE WHEN $2 = 'paused' THEN now() ELSE NULL END
        WHERE id = $1 RETURNING *`,
      [lineId, status]
    );
    const action = status === "paused" ? "line_paused" : "line_resumed";
    await logActivity(handle, { actor: operator, entityType: "line", entityId: lineId, action, detail: line.number });
    await logActivity(handle, { actor: operator, entityType: "company", entityId: line.company_id, action, detail: line.number });
    return updated;
  });
}

/* The kill switch: every active line paused in one go, from a phone. */
export async function pauseAllLines({ operator }) {
  return tx(async (handle) => {
    const paused = await handle.query(
      `UPDATE lines SET status = 'paused', paused_at = now() WHERE status = 'active'
       RETURNING id, company_id, number`
    );
    for (const line of paused) {
      await logActivity(handle, { actor: operator, entityType: "line", entityId: line.id, action: "line_paused", detail: `${line.number} — pause all` });
      await logActivity(handle, { actor: operator, entityType: "company", entityId: line.company_id, action: "line_paused", detail: `${line.number} — pause all` });
    }
    return paused.length;
  });
}

/* Give the number back to Twilio. Irreversible from here -- the route makes
   the operator type the number to confirm. History stays: the line row is
   marked released, never deleted. */
export async function releaseLine({ provider, lineId, typedNumber, operator }) {
  const line = await one(`SELECT * FROM lines WHERE id = $1`, [lineId]);
  if (!line || line.status === "released") throw new ValidationError("That line no longer exists.");
  if (normalizePhone(typedNumber) !== line.number) {
    throw new ValidationError("Type the line's number exactly to release it.", "confirm_number");
  }
  if (line.provider_number_sid) {
    if (!provider.enabled) throw new ValidationError(`Can't release it: ${provider.reason}`);
    await provider.releaseNumber(line.provider_number_sid);
  }
  return tx(async (handle) => {
    await handle.query(
      `UPDATE lines SET status = 'released', released_at = now() WHERE id = $1`, [lineId]
    );
    await handle.query(
      `UPDATE messages SET status = 'cancelled', error_message = 'Line released.', next_attempt_at = NULL
        WHERE line_id = $1 AND status = 'queued'`,
      [lineId]
    );
    await handle.query(`UPDATE conversations SET followup_due_at = NULL WHERE line_id = $1`, [lineId]);
    await logActivity(handle, { actor: operator, entityType: "line", entityId: lineId, action: "line_released", detail: line.number });
    await logActivity(handle, { actor: operator, entityType: "company", entityId: line.company_id, action: "line_released", detail: line.number });
  });
}

/* A text to the owner's phone, proving the sending half works without
   waiting for a real missed call. */
export async function sendTestMessage({ lineId, operator, compose }) {
  return tx(async (handle) => {
    const line = await handle.one(`SELECT * FROM lines WHERE id = $1 FOR UPDATE`, [lineId]);
    if (!line || line.status === "released") throw new ValidationError("That line no longer exists.");
    if (line.status !== "active") throw new ValidationError("Resume the line before sending a test.");
    if (!line.alert_phone) throw new ValidationError("Add the owner's mobile first — the test goes there.");
    const message = await enqueueMessage(handle, {
      line, kind: "test", to: line.alert_phone, body: compose(line), language: line.alert_language,
    });
    await logActivity(handle, { actor: operator, entityType: "line", entityId: lineId, action: "line_test_sent", detail: line.number });
    await logActivity(handle, { actor: operator, entityType: "company", entityId: line.company_id, action: "line_test_sent", detail: line.number });
    return message;
  });
}

/* Friendly wording for provider failures shown to an operator. */
export function providerFailureMessage(err) {
  if (err instanceof ValidationError) return err.message;
  if (err instanceof ProviderError) {
    if (err.ambiguous) return "Twilio did not answer in time. Check the Twilio console before trying again — it may have gone through.";
    return `Twilio refused: ${err.message}`;
  }
  return "Something failed on the server. Nothing was changed.";
}

