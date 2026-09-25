# Frontline Ops — command center

Internal operations tool. Two people, one shared list, a phone in one hand. Not
a public site and not a client portal — everything here is behind a password.

**Selling (Phase 1):** it hands you the next business to call, records what
happened, tells you who to call back, and counts the result.

**Delivering (Phase 2):** it runs the product those businesses buy. Each client
gets a text-back number; their phone forwards missed calls to it; every missed
caller gets a text in English and Spanish within seconds; replies come into the
Inbox and the owner is alerted. The results sit on the client's record, which is
where the conversation about converting a trial happens.

> The LockedinLeads marketing site (`index.html`, `terms.html`, `privacy.html`)
> lives in the `lockedinleads-site` repository, where this app was first built.
> It is a separate, public GitHub Pages deploy — see `../PROVENANCE.md`.

---

## How it works

**Today** is the screen you live in. It hands you one company at a time — Tier A
first, least-recently-called first — with the phone number as a single large tap
target. Four outcomes log with one tap. Three outcomes that carry information
(spoke to owner, callback, trial agreed) open a second screen with the fields
that matter, then return you to a fresh queue.

**Missed calls per week** is required whenever you spoke to the owner. It is the
loudest field on the screen because under 4 means disqualify and move on. It
appears everywhere afterwards — in the pipeline list, on the company record, and
as its own section on Numbers.

**The claim.** Two people working one list will otherwise both dial the same
prospect. When a company is handed to you it is held for 10 minutes. The hold
expires on its own, releases the moment you log the call, and shows on the other
person's Today screen as *"Kory is on Aire Frio AC Repair"* — visible rather than
silent. One person holds one company at a time. Nothing is ever blocked; the
hold only decides who gets offered what.

A business already dialled today never comes back around in the same day's
queue.

### Two deliberate constraints

**No client-side JavaScript.** Every interaction is a link or a form POST. On a
phone with two bars, a page that renders beats one that half-loads, and a tool
you make 40 calls from cannot have state that exists only in browser memory. The
Content-Security-Policy says `default-src 'none'` and means it.

**Mobile first.** Every screen is built for 380px and checked there. Tap targets
are 52px minimum, the outcome buttons sit in the thumb zone, and nothing scrolls
sideways.

---

## Text-back

### What happens on a missed call

1. A customer calls the business's own number. Nobody picks up, so the
   carrier's conditional forwarding sends the call on to the client's
   Frontline Ops number.
2. Twilio asks `/webhooks/twilio/voice` what to do. In one transaction the app
   records the call, finds or opens the caller's conversation, decides whether
   to text, and queues the text. The caller hears a short greeting — "sorry we
   missed you, we just sent you a text" — in English and Spanish, then the call
   ends.
3. The dispatcher sends the text immediately, typically before the greeting has
   finished:

   > AA Eagle Plumbing: Sorry we missed your call. How can we help?
   > Disculpe que no pudimos contestar. ¿En qué le podemos ayudar?

   One SMS segment. A caller who has written before gets their own language
   alone.
4. When they reply, it lands on the conversation in the **Inbox**, their
   language is learned, the pending follow-up is cancelled, and the owner gets
   a text: *"Frontline Ops: nuevo cliente potencial para AA Eagle Plumbing.
   (305) 555-0142 escribió: …"* — at most one alert per conversation every 15
   minutes.
5. No reply after an hour: one follow-up, sent only between 8am and 8pm on the
   line's clock.

The owner is alerted when a customer **replies**, not on every missed call.

### Whether a call gets a text

In order — the first that applies wins, and every call is recorded either way:

| | |
|---|---|
| Line paused | not texted |
| No usable caller ID (blocked, anonymous, non-US) | not texted |
| Carrier says the caller ID is forged (STIR/SHAKEN failed) | not texted |
| Trial over and not a client | not texted |
| Caller opted out | not texted |
| Texted them in the last 12 hours | not texted again |
| Line at its 24-hour cap (default 200) | not texted |
| Otherwise | texted |

**Trials end by themselves.** A line texts while its company is a paying client,
or has a trial that has not ended, plus a three-day grace period after. Like the
dial claim, this is worked out when a call arrives — there is no job that
switches lines off. Today lists trials two days before they stop, during grace,
and for two weeks after. Ticking a trial "converted" before the client record
exists keeps the trial's own window, so there is no gap and no free service if
the client record is forgotten.

**Demo lines** are always on, whatever the trial says — for showing prospects
the product and for testing. They are labelled everywhere they appear.

### Setting up a client (the trial "install")

On the company's record, under **Text-back**:

1. **Find a number** in their area code and buy it (a confirmation box — Twilio
   bills each number monthly). Or attach a number already in the Twilio
   account.
2. **Set up forwarding** on the business phone. The card shows the carrier codes
   with the number filled in — `**004*+1…#` on AT&T and T-Mobile, `*71…` on
   Verizon.
3. **Call the business number** from another phone and let it ring out. The card
   flips to *Forwarding verified* and the phone gets the text.
4. **Test text to owner** confirms the owner's alerts arrive.

Settings on the same card: the name used in texts, first-text languages, the
owner's mobile and language, the follow-up delay, the daily cap, the time zone,
and per-language rewording of the first text and the follow-up. **Pause
texting** stops a line instantly; **Pause every line** on Numbers stops all of
them. **Release** gives the number back to Twilio (you type the number to
confirm) and keeps the history.

### Opt-outs

`STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT` — Twilio confirms these
itself. `PARAR`, `ALTO`, `BAJA`, `CANCELAR`, `DETENER` — the app records them
and sends one Spanish confirmation. `START` re-subscribes. An opted-out customer
gets no text-back and no follow-up; calling them is still fine. A keyword counts
only as the whole message — "stop by tomorrow" is a reply. The app never
auto-replies to a customer's message, so two automated systems cannot loop.

### Languages

English and Spanish today. Each language is one module in
`src/delivery/language/` holding every phrase, its opt-out words and some
detection hints, plus one row in the `languages` table. Adding Portuguese is a
`pt.js`, one line in the registry, and a one-line migration; the tests check
the code and the table agree and that no phrase is missing.

### The one background loop

Phase 1 deliberately has no background jobs. Text-back needs one: a text must go
out whether or not anyone is looking. The dispatcher runs inside the web process
every 5 seconds, and immediately whenever a webhook queues something. Rows are
claimed with `FOR UPDATE SKIP LOCKED`, so machines share the work without
duplicating it. A failed send is retried with backoff when it provably never
reached Twilio; a send that timed out is marked *unconfirmed* and never
retried, because a duplicate text is worse than a missing one. A stuck sender
shows on Today and Numbers rather than failing silently.

---

## Local setup

Requires Node 22+ and Postgres 16+.

```bash
cd app
npm install

# 1. A database
createdb frontline

# 2. Configuration
cp .env.example .env

# 3. A password (the plaintext never leaves your shell)
npm run hash-password -- 'something long you will remember'
#   -> paste the output into APP_PASSWORD_HASH in .env

# 4. A session secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#   -> paste into SESSION_SECRET in .env

# 5. Schema
npm run migrate

# 6. Go
npm start          # http://localhost:8080
npm run dev        # same, restarts on file change
```

### Text-back without Twilio

Set `SMS_PROVIDER=fake` in `.env`. Everything works — buying numbers, the
Inbox, alerts, follow-ups — except that texts are recorded instead of delivered.
Then play Twilio's part from another terminal:

```bash
npm run simulate -- call +13055550142 +13055550110        # caller, line
npm run simulate -- text +13055550142 +13055550110 "Hola, tengo una fuga"
npm run simulate -- status 12 delivered                   # message id
```

The fake provider is refused outright when `NODE_ENV=production`.

### Environment variables

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/dbname`. Append `?sslmode=require` for a managed database. |
| `APP_PASSWORD_HASH` | yes | scrypt hash from `npm run hash-password`. Never the plaintext. |
| `SESSION_SECRET` | yes | 32+ random bytes. Changing it signs everyone out. |
| `APP_USERS` | no | Comma-separated operator names for the login screen. Default `Kory`. Set to `Kory,Isa`. |
| `PORT` | no | Default 8080. |
| `LOG_LEVEL` | no | Default `info`. |
| `TWILIO_ACCOUNT_SID` | for text-back | `AC…`. With the auth token, switches text-back on. |
| `TWILIO_AUTH_TOKEN` | for text-back | Used to check Twilio's webhook signatures (and for API calls if no API key is set). |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | recommended | `SK…` key for API calls, revocable on its own. Both or neither. |
| `TWILIO_MESSAGING_SERVICE_SID` | recommended | `MG…` — the Messaging Service tied to the A2P campaign. New numbers are added to it. |
| `PUBLIC_BASE_URL` | no | Where Twilio reaches the app. Defaults to `https://<FLY_APP_NAME>.fly.dev`; set it for a custom domain. |
| `SMS_PROVIDER` | no | `fake` for local development. Refused in production. |

Without the Twilio variables the app runs normally with text-back switched off,
and says why on the company page (and on Today, once a line depends on it). A
malformed value is reported by name at boot — never echoed.

`.env` is gitignored. Nothing secret is ever committed.

---

## Importing prospects

**From a phone:** Pipeline → *Import prospects*. Pick the CSV (or paste it), read
the report — rows that will import, rows rejected and why, duplicate phones —
then confirm. Nothing is written before you confirm.

**From a terminal** with database access:

```bash
npm run import -- prospects.csv --dry-run     # parse and report, write nothing
npm run import -- prospects.csv --source="hialeah batch 1" --actor=Kory
```

Expected header — order does not matter, extra columns are ignored:

```
company_name,niche,phone,address,city,zip,google_rating,review_count,tier,notes
```

- `phone` is the identity. E.164 (`+13055551234`) is preferred; a bare US
  10-digit number is normalised. **Re-running the same file never creates
  duplicates** — it matches on phone and updates instead.
- `google_rating` and `review_count` may be empty.
- `tier` must be `A` or `B`.
- A row that fails validation is reported by line number and skipped; the rest
  still import.
- Two rows sharing a phone: the last wins, and the dropped one is named.

**A re-import never overwrites your work.** Status, claims, and call history are
untouched. The `notes` column is only written when the company's notes are still
empty, so an operator's note about a call is never clobbered by a fresh copy of
the list.

Both routes run the same code (`src/importer.js`), so a file is treated
identically however it arrives.

`sample-prospects.csv` is fictional test data — replace it with your real list.

---

## Tests

85 tests in four files, run one file at a time against one database:

| File | Covers |
|---|---|
| `smoke.js` (19) | Phase 1: claim concurrency, the missed-calls requirement (in the app *and* the database), rollback taking its `activity_log` row with it, money as cents, DST, HTML escaping |
| `phase2-units.js` (22) | Twilio's signature scheme against its published example, TwiML escaping, SMS segment counting, wording, language detection, opt-out keywords, sending hours across DST, CSRF tokens, provider selection, and the Twilio client's error handling against a stubbed `fetch` |
| `phase2-delivery.js` (30) | Every text-back rule above, trial expiry and grace, replies and alert throttling, opt-out and opt-in, tenant isolation (in the app and as foreign keys), two dispatchers never double-sending, retry vs. unconfirmed vs. refused, out-of-order receipts, follow-up timing, metrics |
| `phase2-http.js` (14) | The whole server: sign-in still guards everything, every POST form carries a CSRF token, forged/cross-site writes are refused and write nothing, the Phase 1 call loop end to end, webhook signatures, the phone import |

They need a throwaway database, named explicitly so the suite can never be
pointed at your real data by accident:

```bash
createdb frontline_test
TEST_DATABASE_URL=postgres://frontline:frontline@localhost:5432/frontline_test npm test
```

`.github/workflows/test.yml` runs them on every push and pull request against
Postgres 17, after checking every file parses, that migrations apply and
re-apply cleanly, and that an existing Phase 1 database upgrades with its data
intact.

The mobile layout is verified in headless Chromium at 375x667 and 380x780: no
horizontal overflow on any screen, and the phone number plus both primary
outcome buttons sit above the fold on Today.

---

## Deploying to Fly.io

### The usual way: from a browser

`.github/workflows/deploy.yml` runs the whole deploy on a GitHub runner, so no
laptop is needed. **Actions → Deploy to Fly → Run workflow.**

It needs two repository secrets (Settings → Secrets and variables → Actions):

| Secret | What it is |
|---|---|
| `FLY_API_TOKEN` | A Fly access token |
| `APP_PASSWORD` | The password typed at sign-in (10+ characters) |

Every step checks before it acts — the app and the database are created only if
absent, attach is skipped when `DATABASE_URL` already exists, and an existing
`SESSION_SECRET` is kept rather than regenerated (regenerating it signs everyone
out). So re-running is safe and will not build a second database.

The `cluster_id` input skips the database lookup when you already know the id —
useful if `fly mpg list` misbehaves.

Text-back needs its Twilio values added as repository secrets too
(`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and ideally `TWILIO_API_KEY_SID`,
`TWILIO_API_KEY_SECRET`, `TWILIO_MESSAGING_SERVICE_SID`). The workflow stages
whichever are present into Fly and never prints them. Leave them out and the
deploy is exactly as before, with text-back switched off.

### Twilio, once

1. **A paid account.** Trial accounts can only text verified numbers and prefix
   every text.
2. **A2P 10DLC registration.** US carriers block or filter business texting from
   unregistered local numbers. Register the brand and a campaign (missed-call
   follow-up / customer care) under the name customers will see, with the
   opt-in and privacy pages the campaign form asks for. Because texts go out in
   each client's name, check Twilio's current guidance on registering as an
   ISV — it may mean one registration per client, which the per-line
   messaging-service field allows for. Approval takes days to weeks; carrier
   error 30007 on Numbers is the sign something is wrong.
3. **A Messaging Service** tied to the campaign, with *Incoming Messages* set to
   **Defer to sender's webhook** — each number's own webhook, which the app
   sets when it buys or attaches the number, is what routes replies here. Put
   its `MG…` id in `TWILIO_MESSAGING_SERVICE_SID`.
4. **An API key** (Console → API keys) for `TWILIO_API_KEY_SID`/`_SECRET`.

Then deploy, open a company, and set up a **demo line** on your own phone before
the first real trial.

### By hand, from a machine with flyctl

```bash
fly launch --no-deploy --copy-config      # once; keeps the fly.toml here

# Managed Postgres. `fly postgres` (unmanaged) is being retired and its region
# list no longer carries mia.
fly mpg create --name frontline-db --region iad --org personal \
  --plan Basic --pg-major-version 17

# attach takes the CLUSTER ID, not the name -- `fly mpg list --org personal`
fly mpg attach <CLUSTER_ID> --app frontline-ops

fly secrets set \
  SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" \
  APP_PASSWORD_HASH='<paste from npm run hash-password>' \
  APP_USERS='Kory,Isa'

fly deploy
```

### Regions

Both the app and the database sit in `iad` (Ashburn, Virginia).

Miami would have been the obvious home, but Fly deprecated `mia` for new
machines — and Managed Postgres never offered it. Co-locating the two in `iad`
matters more than proximity to Hialeah: the distance to a caller's phone is paid
once per request, while an app-to-database hop is paid several times over.

### Cost

The Basic Managed Postgres plan bills **$38/month** (shared 2× CPU, 1 GB RAM,
10 GB disk) on top of the app machine. `fly mpg create --help` lists Starter,
Launch, Scale and Performance as alternatives.

### Notes

`release_command` runs the migrations before new machines take traffic. The
runner holds an advisory lock and records what it has applied, so a retried
release is harmless.

`min_machines_running = 1` keeps a machine warm — a cold start mid-call-block is
exactly the friction that makes someone stop using the tool.

Health check: `GET /healthz` (checks the database, not just the process).
Text-back health — texts queued, stuck, failed or carrier-filtered — is on
Numbers and, when something is wrong, at the top of Today.

### Operators

```bash
fly secrets set APP_USERS='Kory,Isa'
```

Both names then appear on the login screen behind the same password. The name
picked at sign-in becomes `calls.called_by` and `activity_log.actor` for that
session — it is validated server-side against this list, so a hand-crafted form
post cannot invent an operator. Removing a name immediately invalidates their
sessions.

---

## Data model

Real foreign keys, migrations from the first commit. Phase 1:

| Table | Holds |
|---|---|
| `companies` | The list. Plus `claimed_by` / `claimed_at` for the dial hold. |
| `contacts` | People at a company, with `preferred_language` (`es`/`en`). |
| `calls` | Every dial: outcome, missed calls/week, objection, notes, callback time. |
| `trials` | 14-day trials, opened automatically on a `trial_agreed` outcome. |
| `clients` | Paying clients: plan, monthly rate, setup fee, churn. |
| `payments` | Setup and monthly payments against a client. |
| `activity_log` | Append-only. Every write lands here. |

Phase 2 (`002_textback.sql`, `003_import_batches.sql` — additive only; no Phase 1
table was changed, so the Phase 1 code runs on this schema unmodified):

| Table | Holds |
|---|---|
| `lines` | A client's number and how it behaves: name in texts, languages, owner's mobile, follow-up, cap, demo flag, status. One live line per company. |
| `line_templates` | A client's rewording of the first text or follow-up, per language. |
| `conversations` | One per caller per line: status, language, opt-out, follow-up due. |
| `messages` | Every SMS in and out, and the outbox: status, segments, Twilio id, errors, attempts. Never deleted. |
| `missed_calls` | Every call that reached a line, and why it was or was not texted. |
| `languages` | The supported language codes. |
| `provider_events` | Raw signed webhook payloads, kept 30 days for support questions. |
| `rate_limits` | Rate-limit counters, shared by every machine. |
| `import_batches` | A checked prospect file waiting for its confirmation. Kept 7 days. |

**The business being served is the tenant.** Every delivery row carries
`company_id` and `line_id`, and composite foreign keys tie line to company and
conversation to line — the database itself refuses a message filed under one
business on another's line. Webhooks find the line only from the number Twilio
says was called.

Conventions:

- **Money is integer cents.** No float ever touches a revenue figure.
- **Timestamps are `timestamptz`, stored UTC, displayed America/New_York.** A
  9pm call counts toward the day it was actually made. `datetime-local` input is
  resolved against the New York offset in effect at that instant, including
  across a DST boundary.
- **Controlled vocabularies are `CHECK` constraints**, so a later migration can
  widen one with a plain `ALTER`.
- **`missed_calls_per_week` is required on `spoke_to_owner`** at the database
  level, not only in the form.
- **Every write and its `activity_log` row share one transaction**, so a logged
  action and its effect can never diverge.

### Migrations

Plain numbered `.sql` files in `migrations/`, applied in filename order and
recorded in `schema_migrations`. To add one:

```bash
# migrations/002_whatever.sql
npm run migrate
```

Never edit an applied migration — write a new one.

---

## Layout

```
app/
├── migrations/                 001 schema, 002 text-back, 003 import batches
├── public/app.css              the whole design system
├── scripts/
│   ├── migrate.js              apply migrations
│   ├── import-csv.js           idempotent prospect import
│   ├── hash-password.js        generate APP_PASSWORD_HASH
│   └── simulate.js             play Twilio against a local server
└── src/
    ├── server.js               entry, security headers, CSRF, route registration
    ├── db.js                   pool, tx(), migration runner
    ├── auth.js                 scrypt, signed session cookie, operator roster
    ├── queue.js                dial queue + the 10-minute claim
    ├── calls.js                logging a call (one transaction)
    ├── stats.js                every figure on Numbers
    ├── importer.js             prospect CSV checks + upsert (CLI and phone)
    ├── validate.js             server-side validation
    ├── html.js                 escape-by-default templating
    ├── time.js                 UTC storage, New York display
    ├── csv.js                  CSV reader
    ├── security/               CSRF, rate limits
    ├── providers/              the SMS/voice seam: twilio, fake, selection
    ├── delivery/               text-back: missed calls, replies, outbox,
    │                           follow-ups, lines, entitlement, metrics,
    │                           dispatcher, language/ (en, es)
    ├── routes/                 today, inbox, pipeline, company, lines, import,
    │                           numbers, activity, auth, webhooks
    └── views/                  one module per screen
```

Still four runtime dependencies: `fastify`, `@fastify/cookie`,
`@fastify/formbody`, `pg`. Twilio is spoken to with `fetch`, and file uploads
are parsed by Node's own `Response.formData()`.

---

## Design tokens

In `public/app.css` under `:root`. Tune them there; nothing is hard-coded
elsewhere.

The rules that keep it readable across a four-hour call block:

- The gradient is for accents, headings and the primary button only. Never body
  text, never a large fill.
- Body copy is plain `--text` on `--surface`.
- Nothing you read repeatedly has a glow.
- Outcome buttons are **distinct solid colours** — under pressure they are
  identified by colour before the label is read.
- Dark theme only.

Headings use a condensed stack (`Barlow Condensed`, falling back to
`Helvetica Neue Condensed` / `Arial Narrow`, both present on iOS and most
desktops). No web font is downloaded — one less thing to fail on a bad
connection. To use a hosted condensed face instead, add the `<link>` in
`src/views/layout.js` and the CSP `style-src` in `src/server.js`.

---

## Security

- Single shared password, scrypt-hashed (N=16384), never stored or logged in
  plaintext. Sign-in takes the same time whether or not the operator name was
  valid, so the form cannot be used to enumerate who works here.
- Session is a signed, `httpOnly`, `sameSite=lax` cookie; `secure` in
  production. A forged or tampered cookie is rejected.
- **CSRF:** every write must come from this site (`Origin` /
  `Sec-Fetch-Site`) *and* carry a token bound to the session. The token is
  added to every POST form automatically on the way out, so a new form cannot
  forget it. Sign-in is covered by the origin check.
- **Rate limits** in Postgres, so they hold across machines: 10 failed sign-ins
  per address and 100 overall per 15 minutes; 120 webhooks per line per
  minute; 10 number purchases an hour; each line's 24-hour text cap.
- **Twilio webhooks** carry no session and no token; instead each must carry a
  valid Twilio signature over the exact public URL and parameters, checked
  before anything is read. Unsigned requests get a 403 and touch nothing.
- **Credentials** come only from the environment. Twilio's are never logged,
  echoed at boot, or shown on a page; the deploy workflow stages them with its
  output discarded.
- `Content-Security-Policy: default-src 'none'` — the app ships no JavaScript,
  so the policy needs no exceptions.
- Every template value is HTML-escaped by default; raw output must be opted into.
  Spoken greetings are XML-escaped the same way.
- Every SQL value is a bound parameter. Sort order is chosen from a whitelist and
  never interpolated from the query string.
- Request bodies are never logged — they carry call notes, customers' texts and
  the password. Send failures are logged by message id, never by number or body.

---

## Things deliberately not built

No AI, no LLM calls, no orchestration — the texts are fixed, reviewed wording,
and a reply is handed to the owner rather than answered. (The Starter plan on
the site promises answers and booking; that is the next phase, not this one.)
No client portal: owners are told about replies by text. No billing or Stripe
integration — payments are recorded by hand, because at this size that is
faster and cannot silently disagree with the bank. No email.

Not yet, deliberately: relaying an owner's reply back to the customer, a
Twilio number advertised directly (ring the owner first, then text), voicemail
(Florida needs every party's consent to record), spam-call screening, a landline
lookup before texting (a landline shows as "call them instead" after the fact),
and Portuguese wording.

The schema has room to grow. The application does not reach for it.
