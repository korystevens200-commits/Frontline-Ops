/* Phase 2 integration tests: text-back against a real Postgres.

   Requires the same THROWAWAY database as smoke.js, named explicitly:
     TEST_DATABASE_URL=postgres://.../frontline_test npm test */
import test from "node:test";
import assert from "node:assert/strict";

if (!process.env.TEST_DATABASE_URL) {
  console.error("TEST_DATABASE_URL is not set. Refusing to run against DATABASE_URL.");
  process.exit(1);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { query, one, tx, migrate, closePool } = await import("../src/db.js");
const { createFakeProvider } = await import("../src/providers/fake.js");
const { ProviderError } = await import("../src/providers/common.js");
const { recordMissedCall } = await import("../src/delivery/missed-calls.js");
const { recordInboundMessage } = await import("../src/delivery/inbound.js");
const { dispatchOnce, applyDeliveryStatus, runMaintenance, outboxHealth, enqueueMessage } =
  await import("../src/delivery/outbox.js");
const { enqueueDueFollowups } = await import("../src/delivery/followups.js");
const { entitlementFor } = await import("../src/delivery/entitlement.js");
const { deliveryMetrics } = await import("../src/delivery/metrics.js");
const { releaseLine, pauseAllLines, provisionLine, parseLineSettings } = await import("../src/delivery/lines.js");
const { trialsNeedingAttention } = await import("../src/delivery/attention.js");
const { languageCodes } = await import("../src/delivery/language/index.js");
const { checkProspects, importProspects } = await import("../src/importer.js");

await migrate({ log: () => {} });

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/* Mid-afternoon in New York, so follow-up sending hours are predictable. */
const T0 = new Date("2026-09-24T18:00:00Z");
const at = (ms) => new Date(T0.getTime() + ms);

const CALLER = "+13055550142";
const OWNER = "+17865550177";
let provider;
let seq = 0;

async function reset() {
  await query(`TRUNCATE payments, clients, trials, calls, contacts, companies, activity_log,
                        lines, line_templates, conversations, messages, missed_calls,
                        provider_events, rate_limits, import_batches RESTART IDENTITY CASCADE`);
  provider = createFakeProvider({ baseUrl: "http://localhost:8080" });
}

/* A business with a line. `trial`: 'active' | 'grace' | 'ended' | null. */
async function seedLine({
  name = "AA Eagle Plumbing", phone = "+13055550001", number = "+13055550100",
  trial = "active", client = false, demo = false, status = "active", alertPhone = OWNER,
  languages = ["en", "es"], cap = 200, followup = true,
} = {}) {
  const company = await one(
    `INSERT INTO companies (name, phone, tier, status) VALUES ($1, $2, 'A', 'trial') RETURNING *`, [name, phone]
  );
  if (trial) {
    const ends = { active: at(10 * DAY), grace: at(-1 * DAY), ended: at(-5 * DAY) }[trial];
    await query(
      `INSERT INTO trials (company_id, started_at, ends_at, installed_by) VALUES ($1, $2, $3, 'Kory')`,
      [company.id, new Date(ends.getTime() - 14 * DAY), ends]
    );
  }
  if (client) {
    await query(`INSERT INTO clients (company_id, monthly_rate) VALUES ($1, 49700)`, [company.id]);
  }
  const line = await one(
    `INSERT INTO lines (company_id, number, display_name, primary_language, secondary_language, alert_phone,
                        is_demo, status, paused_at, daily_send_cap, followup_enabled, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'Kory', $12) RETURNING *`,
    [company.id, number, name, languages[0], languages[1] ?? null, alertPhone, demo, status,
     status === "paused" ? T0 : null, cap, followup, at(-20 * DAY)]
  );
  return { company, line };
}

const call = (line, { from = CALLER, sid = `CA${++seq}`, verification = "", now = T0 } = {}) =>
  recordMissedCall({ callSid: sid, from, to: line.number, forwardedFrom: "", verification }, { now });

const text = (line, body, { from = CALLER, sid = `SM${++seq}`, now = T0, confirms = (k) => k === "STOP" } = {}) =>
  recordInboundMessage({ messageSid: sid, from, to: line.number, body, mediaCount: 0 },
                       { now, providerConfirmsOptOut: confirms });

const dispatch = (now = T0) => dispatchOnce({ provider, now, limit: 50 });

/* --- the missed call ------------------------------------------------------------ */

test("a missed call is texted back once, in both languages, and the text goes out", async () => {
  await reset();
  const { line } = await seedLine();
  const result = await call(line);
  assert.equal(result.decision, "texted");
  assert.deepEqual(result.languages, ["en", "es"]);

  const queued = await query(`SELECT * FROM messages`);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].status, "queued");
  assert.equal(queued[0].kind, "textback");
  assert.equal(queued[0].to_number, CALLER);
  assert.equal(queued[0].from_number, line.number);

  const summary = await dispatch();
  assert.equal(summary.sent, 1);
  assert.equal(provider.state.sent.length, 1);
  assert.match(provider.state.sent[0].body, /^AA Eagle Plumbing: Sorry we missed your call/);
  assert.equal(provider.state.sent[0].statusCallback, `http://localhost:8080/webhooks/twilio/message-status?m=${queued[0].id}`);

  const sent = await one(`SELECT * FROM messages WHERE id = $1`, [queued[0].id]);
  assert.equal(sent.status, "sent");
  assert.ok(sent.provider_sid);
  const conversation = await one(`SELECT * FROM conversations`);
  assert.equal(conversation.call_count, 1);
  assert.equal(conversation.followup_due_at.getTime(), at(HOUR).getTime(), "follow-up due an hour later");
  const verified = await one(`SELECT forwarding_verified_at FROM lines WHERE id = $1`, [line.id]);
  assert.ok(verified.forwarding_verified_at, "a call arriving proves forwarding works");
});

test("Twilio retrying the same call webhook never sends a second text", async () => {
  await reset();
  const { line } = await seedLine();
  const first = await call(line, { sid: "CA-retry" });
  const again = await call(line, { sid: "CA-retry" });
  assert.equal(first.decision, "texted");
  assert.equal(again.replay, true);
  assert.equal(again.decision, "texted");
  assert.equal((await query(`SELECT * FROM missed_calls`)).length, 1);
  assert.equal((await query(`SELECT * FROM messages`)).length, 1);
});

test("a caller who rings again within 12 hours gets one text, not two", async () => {
  await reset();
  const { line } = await seedLine();
  assert.equal((await call(line, { now: T0 })).decision, "texted");
  assert.equal((await call(line, { now: at(2 * HOUR) })).decision, "duplicate");
  assert.equal((await call(line, { now: at(13 * HOUR) })).decision, "texted");
  const conversation = await one(`SELECT * FROM conversations`);
  assert.equal(conversation.call_count, 3);
  assert.equal((await query(`SELECT * FROM messages WHERE kind = 'textback'`)).length, 2);
});

test("no caller ID, a forged caller ID, a paused line or a full cap are recorded but not texted", async () => {
  await reset();
  const { line } = await seedLine();
  assert.equal((await call(line, { from: "+266696687" })).decision, "no_caller_id");
  assert.equal((await call(line, { from: "anonymous" })).decision, "no_caller_id");
  assert.equal((await call(line, { from: "+13055550143", verification: "TN-Validation-Failed-A" })).decision, "spam_suspected");
  assert.equal((await query(`SELECT * FROM messages`)).length, 0);
  assert.equal((await query(`SELECT * FROM missed_calls`)).length, 3);

  await reset();
  const paused = await seedLine({ status: "paused" });
  assert.equal((await call(paused.line)).decision, "paused");

  await reset();
  const capped = await seedLine({ cap: 2 });
  assert.equal((await call(capped.line, { from: "+13055550150" })).decision, "texted");
  assert.equal((await call(capped.line, { from: "+13055550151" })).decision, "texted");
  assert.equal((await call(capped.line, { from: "+13055550152" })).decision, "cap_reached");
});

test("texting stops by itself three days after a trial ends", async () => {
  await reset();
  const inGrace = await seedLine({ trial: "grace" });
  assert.equal((await call(inGrace.line)).decision, "texted");

  await reset();
  const ended = await seedLine({ trial: "ended" });
  assert.equal((await call(ended.line)).decision, "not_entitled");
  assert.equal((await query(`SELECT * FROM messages`)).length, 0);

  await reset();
  const demo = await seedLine({ trial: "ended", demo: true });
  assert.equal((await call(demo.line)).decision, "texted", "a demo line is always on");

  await reset();
  const paying = await seedLine({ trial: "ended", client: true });
  assert.equal((await call(paying.line)).decision, "texted", "a paying client is on whatever the trial says");

  await reset();
  const none = await seedLine({ trial: null });
  assert.equal((await call(none.line)).decision, "not_entitled");
});

test("entitlement: grace, conversion before the client record, and churn", async () => {
  await reset();
  const { company } = await seedLine({ trial: "active" });
  const handle = { query, one };
  assert.equal((await entitlementFor(handle, company.id, T0)).basis, "trial");

  await query(`UPDATE trials SET status = 'converted'`);
  const pending = await entitlementFor(handle, company.id, T0);
  assert.equal(pending.basis, "converted_pending");
  assert.equal(pending.active, true, "no gap between ticking converted and entering the client");
  assert.equal((await entitlementFor(handle, company.id, at(20 * DAY))).active, false,
               "but no free service past the trial if the client record never comes");

  await query(`INSERT INTO clients (company_id, monthly_rate) VALUES ($1, 49700)`, [company.id]);
  assert.equal((await entitlementFor(handle, company.id, at(60 * DAY))).basis, "client");
  await query(`UPDATE clients SET status = 'churned', churned_at = now()`);
  assert.equal((await entitlementFor(handle, company.id, T0)).basis, "client_churned");
});

/* --- replies, alerts, opt-outs ------------------------------------------------------- */

test("a reply is captured, its language learned, the follow-up cancelled, and the owner alerted", async () => {
  await reset();
  const { line } = await seedLine();
  await call(line);
  await dispatch();

  const result = await text(line, "Hola, tengo una fuga en el baño", { now: at(5 * 60_000) });
  assert.equal(result.outcome, "reply");
  const conversation = await one(`SELECT * FROM conversations`);
  assert.equal(conversation.status, "replied");
  assert.equal(conversation.language, "es");
  assert.equal(conversation.followup_due_at, null);
  assert.ok(conversation.first_reply_at);

  const alert = await one(`SELECT * FROM messages WHERE kind = 'owner_alert'`);
  assert.equal(alert.to_number, OWNER);
  assert.equal(alert.from_number, line.number);
  assert.equal(alert.conversation_id, conversation.id);
  assert.match(alert.body, /^Frontline Ops: nuevo cliente potencial para AA Eagle Plumbing\. \(305\) 555-0142 escribió/);

  /* The next call from them is answered in Spanish alone. */
  const next = await call(line, { now: at(20 * HOUR) });
  assert.deepEqual(next.languages, ["es"]);
  const second = await one(`SELECT body FROM messages WHERE kind = 'textback' ORDER BY id DESC LIMIT 1`);
  assert.match(second.body, /^Hola, le escribe AA Eagle Plumbing/);
});

test("a burst of replies costs one owner alert, and a later one gets another", async () => {
  await reset();
  const { line } = await seedLine();
  await call(line);
  await text(line, "Hi, I need a plumber", { now: at(60_000) });
  await text(line, "Today if possible", { now: at(2 * 60_000) });
  await text(line, "My address is 4410 SW 92nd Ct", { now: at(3 * 60_000) });
  assert.equal((await query(`SELECT * FROM messages WHERE kind = 'owner_alert'`)).length, 1);
  assert.equal((await query(`SELECT * FROM messages WHERE kind = 'reply'`)).length, 3);
  await text(line, "Still there?", { now: at(20 * 60_000) });
  assert.equal((await query(`SELECT * FROM messages WHERE kind = 'owner_alert'`)).length, 2);
});

test("nobody is auto-replied to, so two bots cannot loop", async () => {
  await reset();
  const { line } = await seedLine({ alertPhone: "" });
  await call(line);
  await dispatch();
  for (let i = 0; i < 10; i += 1) {
    await text(line, `Thanks for your message! This is an automated reply ${i}.`, { now: at((i + 1) * 60_000) });
    await dispatch(at((i + 1) * 60_000));
  }
  assert.equal(provider.state.sent.length, 1, "only the original text-back ever went to the customer");
});

test("the owner texting their own line is not treated as a lead", async () => {
  await reset();
  const { line } = await seedLine();
  const result = await text(line, "Got it, calling them now", { from: OWNER });
  assert.equal(result.outcome, "owner_message");
  assert.equal((await query(`SELECT * FROM conversations`)).length, 0);
  assert.equal((await query(`SELECT * FROM messages`)).length, 0);
});

test("STOP and PARAR opt out; Twilio confirms STOP itself, the app confirms PARAR; START undoes it", async () => {
  await reset();
  const { line } = await seedLine();
  await call(line);
  assert.equal((await text(line, "STOP")).outcome, "optout");
  let conversation = await one(`SELECT * FROM conversations`);
  assert.ok(conversation.opted_out_at);
  assert.equal(conversation.followup_due_at, null);
  assert.equal((await query(`SELECT * FROM messages WHERE kind = 'optout_confirm'`)).length, 0,
               "Twilio sends its own confirmation for STOP");
  const cancelled = await one(`SELECT status FROM messages WHERE kind = 'textback'`);
  assert.equal(cancelled.status, "cancelled", "the text-back still queued is not sent");
  assert.equal((await query(`SELECT * FROM messages WHERE kind = 'owner_alert'`)).length, 0);

  assert.equal((await call(line, { now: at(20 * HOUR) })).decision, "opted_out");

  assert.equal((await text(line, "START")).outcome, "optin");
  conversation = await one(`SELECT * FROM conversations`);
  assert.equal(conversation.opted_out_at, null);

  await text(line, "parar");
  const confirmation = await one(`SELECT * FROM messages WHERE kind = 'optout_confirm'`);
  assert.equal(confirmation.language, "es");
  assert.match(confirmation.body, /ha sido dado de baja/);
  await dispatch();
  assert.ok(provider.state.sent.some((m) => m.body === confirmation.body), "a confirmation goes even after opt-out");
});

test("'yes' from someone who never opted out is an answer, not a keyword", async () => {
  await reset();
  const { line } = await seedLine();
  await call(line);
  const result = await text(line, "Yes");
  assert.equal(result.outcome, "reply");
  assert.ok(result.alertId);
});

/* --- tenant isolation -------------------------------------------------------------- */

test("one caller phoning two businesses gets two separate conversations", async () => {
  await reset();
  const a = await seedLine({ name: "Business A", phone: "+13055550001", number: "+13055550100" });
  const b = await seedLine({ name: "Business B", phone: "+13055550002", number: "+13055550200", alertPhone: "+17865550188" });
  await call(a.line);
  await call(b.line);
  await text(b.line, "This is for B");

  const conversations = await query(`SELECT * FROM conversations ORDER BY line_id`);
  assert.equal(conversations.length, 2);
  assert.equal(conversations[0].company_id, a.company.id);
  assert.equal(conversations[0].status, "open", "A never saw the reply sent to B");
  assert.equal(conversations[1].status, "replied");
  const alert = await one(`SELECT * FROM messages WHERE kind = 'owner_alert'`);
  assert.equal(alert.to_number, "+17865550188", "only B's owner hears about B's customer");
  assert.match(alert.body, /Business B/);
});

test("the database refuses a row filed under one business on another's line", async () => {
  await reset();
  const a = await seedLine({ name: "Business A", phone: "+13055550001", number: "+13055550100" });
  const b = await seedLine({ name: "Business B", phone: "+13055550002", number: "+13055550200" });
  await call(a.line);
  const conversationA = await one(`SELECT * FROM conversations WHERE line_id = $1`, [a.line.id]);

  await assert.rejects(() => query(
    `INSERT INTO messages (company_id, line_id, direction, kind, from_number, to_number, status, next_attempt_at)
     VALUES ($1, $2, 'outbound', 'test', 'x', 'y', 'queued', now())`, [b.company.id, a.line.id]),
    /messages_line_fk/);
  await assert.rejects(() => query(
    `INSERT INTO messages (company_id, line_id, conversation_id, direction, kind, from_number, to_number, status, next_attempt_at)
     VALUES ($1, $2, $3, 'outbound', 'test', 'x', 'y', 'queued', now())`, [b.company.id, b.line.id, conversationA.id]),
    /messages_conversation_fk/);
  await assert.rejects(() => query(
    `INSERT INTO conversations (company_id, line_id, lead_phone) VALUES ($1, $2, '+13055550999')`,
    [b.company.id, a.line.id]), /conversations_line_fk/);
});

test("a webhook for a number that is no line of ours touches nothing", async () => {
  await reset();
  await seedLine();
  const result = await recordMissedCall({ callSid: "CA-x", from: CALLER, to: "+13055559999" }, { now: T0 });
  assert.equal(result.line, null);
  const inbound = await recordInboundMessage({ messageSid: "SM-x", from: CALLER, to: "+13055559999", body: "hi" }, { now: T0 });
  assert.equal(inbound.outcome, "unknown_line");
  assert.equal((await query(`SELECT * FROM conversations`)).length, 0);
});

/* --- the dispatcher ---------------------------------------------------------------- */

test("two dispatchers running at once send every text exactly once", async () => {
  await reset();
  const { line } = await seedLine({ cap: 500 });
  for (let i = 0; i < 30; i += 1) {
    await call(line, { from: `+130555502${String(i).padStart(2, "0")}` });
  }
  const results = await Promise.all([
    dispatchOnce({ provider, now: T0, limit: 7 }), dispatchOnce({ provider, now: T0, limit: 7 }),
    dispatchOnce({ provider, now: T0, limit: 7 }), dispatchOnce({ provider, now: T0, limit: 7 }),
    dispatchOnce({ provider, now: T0, limit: 7 }),
  ]);
  const claimed = results.reduce((sum, r) => sum + r.claimed, 0);
  assert.equal(claimed, 30);
  const recipients = provider.state.sent.map((m) => m.to);
  assert.equal(recipients.length, 30);
  assert.equal(new Set(recipients).size, 30, "nobody got two");
});

test("a failed send is retried, an ambiguous one is not, and a refusal is final", async () => {
  await reset();
  const { line } = await seedLine();
  await call(line, { from: "+13055550301" });
  provider.failNext(new ProviderError("busy", { code: "20429", retryable: true }));
  assert.equal((await dispatch()).retried, 1);
  let message = await one(`SELECT * FROM messages`);
  assert.equal(message.status, "queued");
  assert.equal(message.attempts, 1);
  assert.equal(message.next_attempt_at.getTime(), at(15_000).getTime());
  assert.equal((await dispatch(at(5_000))).claimed, 0, "not before its backoff");
  assert.equal((await dispatch(at(16_000))).sent, 1);

  await reset();
  const second = await seedLine();
  await call(second.line, { from: "+13055550302" });
  provider.failNext(new ProviderError("timed out", { code: "timeout", ambiguous: true }));
  assert.equal((await dispatch()).unknown, 1);
  message = await one(`SELECT * FROM messages`);
  assert.equal(message.status, "unknown");
  assert.equal((await dispatch(at(DAY))).claimed, 0, "never re-sent on its own");
  /* A late receipt for it resolves the doubt. */
  await applyDeliveryStatus({ messageId: message.id, messageSid: "SMlate", status: "delivered", now: at(60_000) });
  assert.equal((await one(`SELECT status FROM messages`)).status, "delivered");

  await reset();
  const third = await seedLine();
  await call(third.line, { from: "+13055550303" });
  provider.failNext(new ProviderError("unsubscribed", { code: "21610" }));
  assert.equal((await dispatch()).failed, 1);
  const conversation = await one(`SELECT * FROM conversations`);
  assert.ok(conversation.opted_out_at, "error 21610 means they opted out at the carrier");
});

test("a text queued before an opt-out or a pause is not sent", async () => {
  await reset();
  const { line } = await seedLine();
  await call(line);
  await query(`UPDATE conversations SET opted_out_at = now()`);
  assert.equal((await dispatch()).cancelled, 1);
  assert.equal(provider.state.sent.length, 0);

  await reset();
  const paused = await seedLine();
  await call(paused.line);
  await pauseAllLines({ operator: "Kory" });
  assert.equal((await dispatch()).cancelled, 1);
  assert.equal(provider.state.sent.length, 0);
  assert.equal((await query(`SELECT * FROM activity_log WHERE action = 'line_paused'`)).length, 2);
});

test("delivery receipts move forward only, and find their message before Twilio's sid is stored", async () => {
  await reset();
  const { line } = await seedLine();
  await call(line);
  const message = await one(`SELECT * FROM messages`);
  /* A receipt racing ahead of the dispatcher's own update. */
  await query(`UPDATE messages SET status = 'sending' WHERE id = $1`, [message.id]);
  await applyDeliveryStatus({ messageId: message.id, messageSid: "SMrace", status: "delivered", now: T0 });
  let row = await one(`SELECT * FROM messages WHERE id = $1`, [message.id]);
  assert.equal(row.status, "delivered");
  assert.equal(row.provider_sid, "SMrace");

  await applyDeliveryStatus({ messageSid: "SMrace", status: "sent", now: T0 });
  row = await one(`SELECT * FROM messages WHERE id = $1`, [message.id]);
  assert.equal(row.status, "delivered", "a late 'sent' does not undo 'delivered'");

  const mismatch = await applyDeliveryStatus({ messageId: message.id, messageSid: "SMother", status: "failed" });
  assert.equal(mismatch.mismatch, true);
  assert.equal((await one(`SELECT status FROM messages WHERE id = $1`, [message.id])).status, "delivered");
});

test("a send interrupted mid-flight is marked unknown by maintenance, never re-sent", async () => {
  await reset();
  const { line } = await seedLine();
  await call(line);
  await query(`UPDATE messages SET status = 'sending', last_attempt_at = $1`, [at(-10 * 60_000)]);
  const result = await runMaintenance({ now: T0 });
  assert.equal(result.stuck, 1);
  assert.equal((await one(`SELECT status FROM messages`)).status, "unknown");
  const health = await outboxHealth({ now: T0 });
  assert.equal(health.unknown_7d, 1);
  assert.equal(health.stalled, false);
});

test("a backlog shows up as a stalled sender", async () => {
  await reset();
  const { line } = await seedLine();
  await call(line);
  const health = await outboxHealth({ now: at(10 * 60_000) });
  assert.equal(health.queued, 1);
  assert.equal(health.stalled, true);
});

/* --- follow-ups ------------------------------------------------------------------- */

test("one follow-up goes out when there is no reply, only in sending hours", async () => {
  await reset();
  const { line } = await seedLine();
  await call(line);
  await dispatch();

  assert.equal((await enqueueDueFollowups({ now: at(30 * 60_000) })).queued, 0, "not due yet");
  const due = await enqueueDueFollowups({ now: at(61 * 60_000) });
  assert.equal(due.queued, 1);
  const followup = await one(`SELECT * FROM messages WHERE kind = 'followup'`);
  assert.match(followup.body, /^AA Eagle Plumbing: Do you still need help\?/);
  assert.equal((await enqueueDueFollowups({ now: at(5 * HOUR) })).queued, 0, "only one");
});

test("a follow-up due at night waits for 8am", async () => {
  await reset();
  const { line } = await seedLine();
  /* 20:30 EDT. */
  const evening = new Date("2026-09-25T00:30:00Z");
  await call(line, { now: evening });
  const result = await enqueueDueFollowups({ now: new Date("2026-09-25T01:31:00Z") });
  assert.equal(result.deferred, 1);
  const conversation = await one(`SELECT * FROM conversations`);
  assert.equal(conversation.followup_due_at.toISOString(), "2026-09-25T12:00:00.000Z");
  assert.equal((await enqueueDueFollowups({ now: new Date("2026-09-25T12:00:30Z") })).queued, 1);
});

test("no follow-up after a reply, an opt-out, a close, or with follow-ups off", async () => {
  await reset();
  const { line } = await seedLine();
  await call(line, { from: "+13055550401" });
  await call(line, { from: "+13055550402" });
  await call(line, { from: "+13055550403" });
  await text(line, "hi, yes please", { from: "+13055550401", now: at(10 * 60_000) });
  await text(line, "STOP", { from: "+13055550402", now: at(10 * 60_000) });
  await query(`UPDATE conversations SET status = 'closed', closed_at = now() WHERE lead_phone = '+13055550403'`);
  const result = await enqueueDueFollowups({ now: at(2 * HOUR) });
  assert.equal(result.queued, 0);
  assert.equal((await query(`SELECT * FROM messages WHERE kind = 'followup'`)).length, 0);

  await reset();
  const off = await seedLine({ followup: false });
  await call(off.line);
  assert.equal((await one(`SELECT followup_due_at FROM conversations`)).followup_due_at, null);
});

/* --- lines ------------------------------------------------------------------------- */

test("buying a number records the line; a failure to record it gives the number back", async () => {
  await reset();
  const company = await one(`INSERT INTO companies (name, phone, tier) VALUES ('Buyer Co', '+13055550500', 'A') RETURNING *`);
  const settings = parseLineSettings({
    display_name: "Buyer Co", language_mode: "en,es", alert_language: "es", timezone: "America/New_York",
    alert_phone: "(786) 555-0177", followup_enabled: "on",
  });
  const line = await provisionLine({ provider, companyId: company.id, number: "+13055550110", settings, operator: "Kory" });
  assert.equal(line.number, "+13055550110");
  assert.equal(line.alert_phone, "+17865550177");
  assert.equal(provider.state.purchased.length, 1);
  const log = await query(`SELECT * FROM activity_log WHERE action = 'line_created'`);
  assert.equal(log.length, 2, "on the company and on the line");

  /* A second line for the same business is refused before any money is spent. */
  await assert.rejects(() => provisionLine({ provider, companyId: company.id, number: "+13055550111", settings, operator: "Kory" }),
                       /already has a text-back line/);
  assert.equal(provider.state.purchased.length, 1);
});

test("releasing a line needs the number typed, cancels what was queued, and keeps the history", async () => {
  await reset();
  const { line } = await seedLine();
  line.provider_number_sid = "PNfake";
  await query(`UPDATE lines SET provider_number_sid = 'PNfake'`);
  await call(line);
  await assert.rejects(() => releaseLine({ provider, lineId: line.id, typedNumber: "305", operator: "Kory" }), /exactly/);
  await releaseLine({ provider, lineId: line.id, typedNumber: "(305) 555-0100", operator: "Kory" });
  assert.deepEqual(provider.state.released, ["PNfake"]);
  assert.equal((await one(`SELECT status FROM lines`)).status, "released");
  assert.equal((await one(`SELECT status FROM messages`)).status, "cancelled");
  assert.equal((await query(`SELECT * FROM missed_calls`)).length, 1, "history stays");
});

test("trials about to stop texting are flagged for Today", async () => {
  await reset();
  await seedLine({ name: "Ending Soon", phone: "+13055550601", number: "+13055550701", trial: "active" });
  await query(`UPDATE trials SET ends_at = $1`, [at(DAY)]);
  await seedLine({ name: "In Grace", phone: "+13055550602", number: "+13055550702", trial: "grace" });
  await seedLine({ name: "Stopped", phone: "+13055550603", number: "+13055550703", trial: "ended" });
  await seedLine({ name: "Fine", phone: "+13055550604", number: "+13055550704", trial: "active" });
  await seedLine({ name: "Paying", phone: "+13055550605", number: "+13055550705", trial: "ended", client: true });
  const flagged = await trialsNeedingAttention({ query, one }, T0);
  assert.deepEqual(flagged.map((t) => [t.company_name, t.state]),
    [["Stopped", "stopped"], ["In Grace", "grace"], ["Ending Soon", "ending"]]);
});

/* --- metrics ------------------------------------------------------------------------ */

test("delivery numbers add up from the rows", async () => {
  await reset();
  const { line } = await seedLine();
  await call(line, { from: "+13055550801" });
  await call(line, { from: "+13055550802" });
  await call(line, { from: "anonymous" });
  await dispatch();
  await text(line, "Hola, necesito ayuda", { from: "+13055550801", now: at(60_000) });
  await dispatch(at(60_000));
  await enqueueDueFollowups({ now: at(2 * HOUR) });
  await dispatch(at(2 * HOUR));
  await text(line, "yes still need it", { from: "+13055550802", now: at(3 * HOUR) });
  await dispatch(at(3 * HOUR));
  const followup = await one(`SELECT id FROM messages WHERE kind = 'followup'`);
  await applyDeliveryStatus({ messageId: followup.id, status: "delivered", now: at(2 * HOUR) });

  const m = await deliveryMetrics({ query, one }, { lineId: line.id, from: at(-DAY), to: at(DAY) });
  assert.equal(m.missed_calls, 3);
  assert.equal(m.texted, 2);
  assert.equal(m.no_caller_id, 1);
  assert.equal(m.texts_sent, 3, "two text-backs and one follow-up");
  assert.equal(m.delivered, 1);
  assert.equal(m.replies, 2);
  assert.equal(m.leads_captured, 2);
  assert.equal(m.followups_sent, 1);
  assert.equal(m.replied_after_followup, 1);
  assert.equal(m.owner_alerts, 2);
  assert.ok(m.segments >= 5);
});

/* --- the language table and the code agree ------------------------------------------ */

test("every language in the database has a module, and every module a row", async () => {
  const rows = (await query(`SELECT code FROM languages ORDER BY code`)).map((r) => r.code);
  assert.deepEqual(rows, [...languageCodes()].sort());
});

/* --- import --------------------------------------------------------------------------- */

test("the shared importer is idempotent and never overwrites an operator's notes", async () => {
  await reset();
  const csv = "company_name,phone,tier,notes\nAire Frio,(305) 555-0111,A,from list\nNo Tier,3055550112,Z,\n";
  const check = checkProspects(csv);
  assert.equal(check.toImport.length, 1);
  assert.equal(check.rejected.length, 1);
  const first = await tx((handle) => importProspects(handle, check.toImport, { source: "phone" }));
  assert.deepEqual(first, { created: 1, updated: 0 });
  await query(`UPDATE companies SET notes = 'Owner is Yoandy, call after 3'`);
  const again = await tx((handle) => importProspects(handle, check.toImport, { source: "phone" }));
  assert.deepEqual(again, { created: 0, updated: 1 });
  const company = await one(`SELECT * FROM companies`);
  assert.equal(company.notes, "Owner is Yoandy, call after 3");
  assert.equal(company.source, "phone");
});

test.after(async () => { await closePool(); });
