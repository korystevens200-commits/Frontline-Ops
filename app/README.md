# Frontline Ops — command center

Internal cold-call operations tool. Two people, one shared list, a phone in one
hand. Not a public site and not a client portal — everything here is behind a
password.

It does four things: hands you the next business to call, records what happened,
tells you who to call back, and counts the result.

> The marketing site at the repository root (`index.html`, `terms.html`,
> `privacy.html`) is a separate, public GitHub Pages deploy under the old
> LockedinLeads name. It is untouched by this app and deploys independently.

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

### Environment variables

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/dbname`. Append `?sslmode=require` for a managed database. |
| `APP_PASSWORD_HASH` | yes | scrypt hash from `npm run hash-password`. Never the plaintext. |
| `SESSION_SECRET` | yes | 32+ random bytes. Changing it signs everyone out. |
| `APP_USERS` | no | Comma-separated operator names for the login screen. Default `Kory`. |
| `PORT` | no | Default 8080. |
| `LOG_LEVEL` | no | Default `info`. |

`.env` is gitignored. Nothing secret is ever committed.

---

## Importing prospects

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

`sample-prospects.csv` is fictional test data — replace it with your real list.

---

## Tests

Nineteen smoke tests over the invariants that would hurt most if they broke:
claim concurrency, the missed-calls requirement (in the app *and* in the
database), transaction rollback taking its `activity_log` row with it, money as
integer cents, DST handling, and HTML escaping.

They need a throwaway database, named explicitly so the suite can never be
pointed at your real data by accident:

```bash
createdb frontline_test
TEST_DATABASE_URL=postgres://frontline:frontline@localhost:5432/frontline_test npm test
```

The mobile layout was verified in headless Chromium at 380x780: no horizontal
overflow on any screen, and the phone number plus both primary outcome buttons
sit above the fold.

---

## Deploying to Fly.io

From the `app/` directory:

```bash
fly launch --no-deploy --copy-config      # once; keeps the fly.toml here
fly postgres create --name frontline-db --region mia
fly postgres attach frontline-db          # sets DATABASE_URL

fly secrets set \
  SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" \
  APP_PASSWORD_HASH='<paste from npm run hash-password>' \
  APP_USERS='Kory,Partner'

fly deploy
```

`release_command` runs the migrations before new machines take traffic. The
runner holds an advisory lock and records what it has applied, so a retried
release is harmless.

`min_machines_running = 1` keeps a machine warm — a cold start mid-call-block is
exactly the friction that makes someone stop using the tool.

Health check: `GET /healthz` (checks the database, not just the process).

### Adding the second operator

```bash
fly secrets set APP_USERS='Kory,<her name>'
```

Both names then appear on the login screen behind the same password. The name
picked at sign-in becomes `calls.called_by` and `activity_log.actor` for that
session — it is validated server-side against this list, so a hand-crafted form
post cannot invent an operator. Removing a name immediately invalidates their
sessions.

---

## Data model

Seven tables, real foreign keys, migrations from the first commit.

| Table | Holds |
|---|---|
| `companies` | The list. Plus `claimed_by` / `claimed_at` for the dial hold. |
| `contacts` | People at a company, with `preferred_language` (`es`/`en`). |
| `calls` | Every dial: outcome, missed calls/week, objection, notes, callback time. |
| `trials` | 14-day trials, opened automatically on a `trial_agreed` outcome. |
| `clients` | Paying clients: plan, monthly rate, setup fee, churn. |
| `payments` | Setup and monthly payments against a client. |
| `activity_log` | Append-only. Every write lands here. |

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
├── migrations/001_init.sql     schema
├── public/app.css              the whole design system
├── scripts/
│   ├── migrate.js              apply migrations
│   ├── import-csv.js           idempotent prospect import
│   └── hash-password.js        generate APP_PASSWORD_HASH
└── src/
    ├── server.js               entry, security headers, route registration
    ├── db.js                   pool, tx(), migration runner
    ├── auth.js                 scrypt, signed session cookie, operator roster
    ├── queue.js                dial queue + the 10-minute claim
    ├── calls.js                logging a call (one transaction)
    ├── stats.js                every figure on Numbers
    ├── validate.js             server-side validation
    ├── html.js                 escape-by-default templating
    ├── time.js                 UTC storage, New York display
    ├── csv.js                  CSV reader
    ├── routes/                 today, pipeline, company, numbers, activity, auth
    └── views/                  one module per screen
```

Four runtime dependencies: `fastify`, `@fastify/cookie`, `@fastify/formbody`,
`pg`.

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
- `Content-Security-Policy: default-src 'none'` — the app ships no JavaScript,
  so the policy needs no exceptions.
- Every template value is HTML-escaped by default; raw output must be opted into.
- Every SQL value is a bound parameter. Sort order is chosen from a whitelist and
  never interpolated from the query string.
- Request bodies are never logged — they carry call notes and the password.

---

## Things deliberately not built

No AI, no LLM calls, no orchestration. No client portal. No billing or Stripe
integration — payments are recorded by hand, because at this size that is
faster and cannot silently disagree with the bank. No email automation. No
analytics beyond the counters on Numbers.

The schema has room to grow. The application does not reach for it.
