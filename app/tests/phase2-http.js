/* Phase 2 HTTP tests: the whole server, driven through fastify.inject.

   What these prove: every route is still behind sign-in, every write needs a
   same-origin request AND a valid CSRF token (Phase 1's forms included, and
   they still work), sign-in is rate limited, Twilio webhooks demand a valid
   signature, and the phone import works end to end.

   Requires the same THROWAWAY database as smoke.js:
     TEST_DATABASE_URL=postgres://.../frontline_test npm test */
import test from "node:test";
import assert from "node:assert/strict";

if (!process.env.TEST_DATABASE_URL) {
  console.error("TEST_DATABASE_URL is not set. Refusing to run against DATABASE_URL.");
  process.exit(1);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_SECRET = "http-test-secret-0123456789abcdef0123456789abcdef";
process.env.APP_USERS = "Kory,Isa";
process.env.SMS_PROVIDER = "fake";
process.env.PUBLIC_BASE_URL = "http://localhost:8080";
process.env.LOG_LEVEL = "silent";
delete process.env.NODE_ENV;

const PASSWORD = "a long enough test password";
const { hashPassword } = await import("../src/auth.js");
process.env.APP_PASSWORD_HASH = await hashPassword(PASSWORD);

const { query, one, migrate, closePool } = await import("../src/db.js");
const { build } = await import("../src/server.js");
const { setProvider, disabledProvider } = await import("../src/providers/sms.js");
const { createFakeProvider, FAKE_AUTH_TOKEN } = await import("../src/providers/fake.js");
const { webhookSignature } = await import("../src/providers/common.js");

await migrate({ log: () => {} });
const app = await build();

const HOST = "ops.test";
const ORIGIN = `https://${HOST}`;
let provider;

async function reset() {
  await query(`TRUNCATE payments, clients, trials, calls, contacts, companies, activity_log,
                        lines, line_templates, conversations, messages, missed_calls,
                        provider_events, rate_limits, import_batches RESTART IDENTITY CASCADE`);
  provider = createFakeProvider({ baseUrl: "http://localhost:8080" });
  setProvider(provider);
}

function request(method, url, { cookie = "", headers = {}, form = null, payload = null } = {}) {
  const base = { host: HOST, ...(cookie ? { cookie } : {}) };
  if (method !== "GET") base.origin = ORIGIN;
  if (form) {
    base["content-type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  }
  return app.inject({ method, url, headers: { ...base, ...headers }, payload });
}

async function signIn(operator = "Kory", headers = {}) {
  const res = await request("POST", "/login", { form: { operator, password: PASSWORD, next: "/today" }, headers });
  assert.equal(res.statusCode, 303, "sign-in should succeed");
  const cookie = [res.headers["set-cookie"]].flat().map((c) => c.split(";")[0]).join("; ");
  return cookie;
}

function tokenIn(html) {
  return (html.match(/name="_csrf" value="([^"]+)"/) ?? [])[1];
}

async function csrfFor(cookie, page = "/today") {
  const res = await request("GET", page, { cookie });
  return tokenIn(res.body);
}

function signedWebhook(path, params, { signature } = {}) {
  const url = `http://localhost:8080${path}`;
  return app.inject({
    method: "POST", url: path,
    headers: {
      host: HOST,
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature ?? webhookSignature(FAKE_AUTH_TOKEN, url, params),
    },
    payload: new URLSearchParams(params).toString(),
  });
}

async function seedCompanyWithLine() {
  const company = await one(
    `INSERT INTO companies (name, phone, tier, status) VALUES ('AA Eagle Plumbing', '+13055550001', 'A', 'trial') RETURNING *`
  );
  await query(`INSERT INTO trials (company_id, ends_at, installed_by) VALUES ($1, now() + interval '10 days', 'Kory')`, [company.id]);
  const line = await one(
    `INSERT INTO lines (company_id, number, display_name, alert_phone, created_by)
     VALUES ($1, '+13055550100', 'AA Eagle Plumbing', '+17865550177', 'Kory') RETURNING *`,
    [company.id]
  );
  return { company, line };
}

/* --- sign-in still guards everything -------------------------------------------- */

test("every new screen is behind sign-in", async () => {
  await reset();
  for (const url of ["/inbox", "/conversation/1", "/import", "/import/1", "/company/1/line/numbers?area_code=305"]) {
    const res = await request("GET", url);
    assert.equal(res.statusCode, 303, url);
    assert.match(res.headers.location, /^\/login\?next=/, url);
  }
  for (const url of ["/line/1/settings", "/lines/pause-all", "/import", "/conversation/1/status"]) {
    const res = await request("POST", url, { form: { x: "1" } });
    assert.equal(res.statusCode, 303, url);
    assert.match(res.headers.location, /^\/login/, url);
  }
});

test("sign-in from another site is refused", async () => {
  await reset();
  const res = await request("POST", "/login", {
    form: { operator: "Kory", password: PASSWORD }, headers: { origin: "https://evil.example" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers["set-cookie"], undefined);
});

test("sign-in is rate limited per address after 10 failures", async () => {
  await reset();
  const from = { "fly-client-ip": "203.0.113.9" };
  for (let i = 0; i < 10; i += 1) {
    const res = await request("POST", "/login", { form: { operator: "Kory", password: "wrong" }, headers: from });
    assert.match(res.headers.location, /err=bad/);
  }
  const blocked = await request("POST", "/login", { form: { operator: "Kory", password: PASSWORD }, headers: from });
  assert.match(blocked.headers.location, /err=slow/, "even the right password waits out the window");
  assert.equal(blocked.headers["set-cookie"], undefined);
  await signIn("Kory", { "fly-client-ip": "203.0.113.10" });
});

/* --- CSRF on every write ----------------------------------------------------------- */

test("every POST form on every screen carries a CSRF token", async () => {
  await reset();
  const { company } = await seedCompanyWithLine();
  await query(`INSERT INTO companies (name, phone, tier) VALUES ('Prospect', '+13055550002', 'A')`);
  const cookie = await signIn();
  for (const url of ["/today", "/inbox", "/numbers", "/activity", "/pipeline", "/import",
                     `/company/${company.id}`, "/company/2", `/company/${company.id}/line/numbers?area_code=305`]) {
    const res = await request("GET", url, { cookie });
    assert.equal(res.statusCode, 200, url);
    const forms = (res.body.match(/<form\b[^>]*method="POST"[^>]*>/g) ?? []).length;
    const tokens = (res.body.match(/name="_csrf"/g) ?? []).length;
    assert.ok(forms >= 1, `${url} has a POST form (sign out, at least)`);
    assert.equal(tokens, forms, `${url}: every POST form has a token`);
    assert.match(res.headers["content-security-policy"], /default-src 'none'/, url);
  }
});

test("a write without a valid token, or from another site, is refused and writes nothing", async () => {
  await reset();
  const company = await one(`INSERT INTO companies (name, phone, tier) VALUES ('Target', '+13055550003', 'A') RETURNING *`);
  const cookie = await signIn();
  const isaToken = await csrfFor(await signIn("Isa"));
  const form = { status: "dead", notes: "forged" };

  const missing = await request("POST", `/company/${company.id}/notes`, { cookie, form });
  const wrong = await request("POST", `/company/${company.id}/notes`, { cookie, form: { ...form, _csrf: "nope" } });
  const someoneElses = await request("POST", `/company/${company.id}/notes`, { cookie, form: { ...form, _csrf: isaToken } });
  const crossSite = await request("POST", `/company/${company.id}/notes`, {
    cookie, form: { ...form, _csrf: await csrfFor(cookie) }, headers: { origin: "https://evil.example" },
  });
  for (const res of [missing, wrong, someoneElses, crossSite]) assert.equal(res.statusCode, 403);
  const unchanged = await one(`SELECT status, notes FROM companies WHERE id = $1`, [company.id]);
  assert.deepEqual(unchanged, { status: "new", notes: "" });
  assert.equal((await query(`SELECT * FROM activity_log`)).length, 0);

  const ok = await request("POST", `/company/${company.id}/notes`, { cookie, form: { ...form, _csrf: await csrfFor(cookie) } });
  assert.equal(ok.statusCode, 303);
  assert.equal((await one(`SELECT status FROM companies WHERE id = $1`, [company.id])).status, "dead");
});

test("the Phase 1 call loop still works end to end through the new checks", async () => {
  await reset();
  await query(`INSERT INTO companies (name, phone, tier) VALUES ('Call Me', '+13055550004', 'A'), ('Next Up', '+13055550005', 'A')`);
  const cookie = await signIn();
  const today = await request("GET", "/today", { cookie });
  assert.match(today.body, /Call Me/);
  const companyId = today.body.match(/name="company_id" value="(\d+)"/)[1];

  const logged = await request("POST", "/today/outcome", {
    cookie, form: { company_id: companyId, outcome: "no_answer", _csrf: tokenIn(today.body) },
  });
  assert.equal(logged.statusCode, 303);
  assert.equal(logged.headers.location, "/today?ok=logged");
  assert.equal((await query(`SELECT * FROM calls`)).length, 1);

  const next = await request("GET", "/today?ok=logged", { cookie });
  assert.match(next.body, /Next Up/, "the queue moves on");

  const detail = await request("POST", "/today/log", {
    cookie, form: { company_id: companyId, outcome: "trial_agreed", notes: "yes!", _csrf: tokenIn(next.body) },
  });
  assert.equal(detail.headers.location, "/today?ok=trial_started");
  assert.equal((await query(`SELECT * FROM trials`)).length, 1);
});

/* --- Twilio webhooks ----------------------------------------------------------------- */

test("webhooks demand Twilio's signature", async () => {
  await reset();
  await seedCompanyWithLine();
  const params = { CallSid: "CA1", From: "+13055550142", To: "+13055550100" };
  const unsigned = await app.inject({
    method: "POST", url: "/webhooks/twilio/voice", headers: { host: HOST, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(params).toString(),
  });
  assert.equal(unsigned.statusCode, 403);
  const forged = await signedWebhook("/webhooks/twilio/voice", params, { signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
  assert.equal(forged.statusCode, 403);
  const replayedElsewhere = await signedWebhook("/webhooks/twilio/sms", params,
    { signature: webhookSignature(FAKE_AUTH_TOKEN, "http://localhost:8080/webhooks/twilio/voice", params) });
  assert.equal(replayedElsewhere.statusCode, 403, "a signature is only good for the URL it was made for");
  assert.equal((await query(`SELECT * FROM missed_calls`)).length, 0);
  assert.equal((await query(`SELECT * FROM provider_events`)).length, 0, "nothing unsigned is stored");

  const get = await app.inject({ method: "GET", url: "/webhooks/twilio/voice", headers: { host: HOST } });
  assert.equal(get.statusCode, 404);
});

test("a signed missed call is greeted in both languages and texted back", async () => {
  await reset();
  await seedCompanyWithLine();
  const res = await signedWebhook("/webhooks/twilio/voice",
    { CallSid: "CA2", From: "+13055550142", To: "+13055550100", StirVerstat: "TN-Validation-Passed-A" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/xml/);
  assert.match(res.body, /<Say voice="Polly\.Joanna" language="en-US">Thanks for calling AA Eagle Plumbing\./);
  assert.match(res.body, /<Say voice="Polly\.Lupe" language="es-US">Gracias por llamar/);
  assert.match(res.body, /<Hangup\/><\/Response>$/);
  const message = await one(`SELECT * FROM messages`);
  assert.equal(message.kind, "textback");
  const event = await one(`SELECT * FROM provider_events`);
  assert.equal(event.outcome, "texted");

  const unknown = await signedWebhook("/webhooks/twilio/voice", { CallSid: "CA3", From: "+13055550142", To: "+13055559999" });
  assert.match(unknown.body, /<Response><Hangup\/><\/Response>/);
});

test("replies and delivery receipts arrive through their webhooks", async () => {
  await reset();
  await seedCompanyWithLine();
  await signedWebhook("/webhooks/twilio/voice", { CallSid: "CA4", From: "+13055550142", To: "+13055550100" });
  const reply = await signedWebhook("/webhooks/twilio/sms",
    { MessageSid: "SMin1", From: "+13055550142", To: "+13055550100", Body: "Hola, necesito ayuda", NumMedia: "0" });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.body, `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, "never an inline auto-reply");
  const duplicate = await signedWebhook("/webhooks/twilio/sms",
    { MessageSid: "SMin1", From: "+13055550142", To: "+13055550100", Body: "Hola, necesito ayuda", NumMedia: "0" });
  assert.equal(duplicate.statusCode, 200);
  assert.equal((await query(`SELECT * FROM messages WHERE kind = 'reply'`)).length, 1);

  const textback = await one(`SELECT id FROM messages WHERE kind = 'textback'`);
  const receipt = await signedWebhook(`/webhooks/twilio/message-status?m=${textback.id}`,
    { MessageSid: "SMout1", MessageStatus: "undelivered", ErrorCode: "30006" });
  assert.equal(receipt.statusCode, 204);
  const updated = await one(`SELECT status, error_code, provider_sid FROM messages WHERE id = $1`, [textback.id]);
  assert.deepEqual(updated, { status: "undelivered", error_code: "30006", provider_sid: "SMout1" });

  /* The conversation shows it, and the nav badge counts the reply. */
  const cookie = await signIn();
  const inbox = await request("GET", "/inbox", { cookie });
  assert.match(inbox.body, /\(305\) 555-0142/);
  assert.match(inbox.body, /<span class="badge">1<\/span>/);
  const conversation = await request("GET", "/conversation/1", { cookie });
  assert.match(conversation.body, /Hola, necesito ayuda/);
  assert.match(conversation.body, /landline — call them instead/);
});

test("a flood on one line is acknowledged but not processed", async () => {
  await reset();
  await seedCompanyWithLine();
  await query(
    `INSERT INTO rate_limits (bucket, key, window_start, hits)
     VALUES ('webhook_line', '+13055550100', to_timestamp(floor(extract(epoch FROM now()) / 60) * 60), 120)`
  );
  const res = await signedWebhook("/webhooks/twilio/voice", { CallSid: "CA5", From: "+13055550142", To: "+13055550100" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<Response><Hangup\/><\/Response>/);
  assert.equal((await query(`SELECT * FROM messages`)).length, 0);
  assert.equal((await one(`SELECT outcome FROM provider_events`)).outcome, "rate_limited");
});

test("with no provider configured, webhooks say so and the rest of the app carries on", async () => {
  await reset();
  await seedCompanyWithLine();
  setProvider(disabledProvider("Twilio is not configured: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not set."));
  const res = await signedWebhook("/webhooks/twilio/voice", { CallSid: "CA6", From: "+13055550142", To: "+13055550100" });
  assert.equal(res.statusCode, 503);
  const cookie = await signIn();
  const today = await request("GET", "/today", { cookie });
  assert.equal(today.statusCode, 200);
  assert.match(today.body, /Text-back is off: Twilio is not configured/, "loud, because a live line depends on it");
  const company = await request("GET", "/company/1", { cookie });
  assert.match(company.body, /switched off on the server/);
});

/* --- operator actions ------------------------------------------------------------------ */

test("buying a number needs the confirmation box, then goes live", async () => {
  await reset();
  const company = await one(`INSERT INTO companies (name, phone, tier) VALUES ('Buyer', '+13055550010', 'A') RETURNING *`);
  const cookie = await signIn();
  const picker = await request("GET", `/company/${company.id}/line/numbers?area_code=305`, { cookie });
  assert.match(picker.body, /\(305\) 555-0110/);
  const form = {
    _csrf: tokenIn(picker.body), number: "+13055550110", display_name: "Buyer", language_mode: "en,es",
    alert_phone: "7865550177", alert_language: "es", timezone: "America/New_York", followup_enabled: "on",
  };
  const unconfirmed = await request("POST", `/company/${company.id}/line/provision`, { cookie, form });
  assert.match(decodeURIComponent(unconfirmed.headers.location), /Tick the box/);
  assert.equal(provider.state.purchased.length, 0, "no money spent");

  const bought = await request("POST", `/company/${company.id}/line/provision`, { cookie, form: { ...form, confirm: "yes" } });
  assert.equal(bought.headers.location, `/company/${company.id}?ok=line_created#line`);
  const line = await one(`SELECT * FROM lines`);
  assert.equal(line.number, "+13055550110");
  const page = await request("GET", `/company/${company.id}`, { cookie });
  assert.match(page.body, /\*\*004\*\+13055550110#/, "forwarding code for the owner's phone");
  assert.match(page.body, /A new caller receives/);
});

test("a prospect list uploaded from a phone is checked, then imported", async () => {
  await reset();
  const cookie = await signIn();
  const token = await csrfFor(cookie, "/import");
  const boundary = "----frontlineops";
  const csv = "company_name,phone,tier,niche\r\nCafé Niño AC,(305) 555-0300,A,AC\r\nNo Phone,,B,\r\n";
  const payload =
    `--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${token}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="source"\r\n\r\nphone batch\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="prospects.csv"\r\n` +
    `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
  const upload = await app.inject({
    method: "POST", url: "/import",
    headers: { host: HOST, origin: ORIGIN, cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(payload, "utf8"),
  });
  assert.equal(upload.statusCode, 303);
  assert.equal(upload.headers.location, "/import/1");
  assert.equal((await query(`SELECT * FROM companies`)).length, 0, "nothing written before confirming");

  const review = await request("GET", "/import/1", { cookie });
  assert.match(review.body, /Line 3: unusable phone/);
  assert.match(review.body, /Import 1 company/);

  const tokenless = await app.inject({
    method: "POST", url: "/import",
    headers: { host: HOST, origin: ORIGIN, cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(payload.replace(token, "forged"), "utf8"),
  });
  assert.equal(tokenless.statusCode, 403, "the token is checked on uploads too");

  const commit = await request("POST", "/import/1/commit", { cookie, form: { _csrf: tokenIn(review.body) } });
  assert.equal(commit.headers.location, "/import/1?ok=imported");
  const company = await one(`SELECT name, phone, source FROM companies`);
  assert.deepEqual(company, { name: "Café Niño AC", phone: "+13055550300", source: "phone batch" });
  const log = await one(`SELECT * FROM activity_log WHERE action = 'csv_import'`);
  assert.equal(log.actor, "Kory");
  assert.match(log.detail, /prospects\.csv: 1 created, 0 updated, 1 rejected/);
});

test("an operator action on something that does not exist fails politely", async () => {
  await reset();
  const cookie = await signIn();
  const token = await csrfFor(cookie);
  const res = await request("POST", "/line/999/settings", {
    cookie, form: { _csrf: token, display_name: "X", language_mode: "en", alert_language: "en", timezone: "America/New_York" },
  });
  assert.equal(res.statusCode, 303);
  assert.match(decodeURIComponent(res.headers.location), /no longer exists/);
  const conversation = await request("GET", "/conversation/999", { cookie });
  assert.equal(conversation.statusCode, 303);
});

test.after(async () => {
  await app.close();
  await closePool();
});
