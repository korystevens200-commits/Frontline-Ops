-- Frontline Ops: initial schema.
--
-- Conventions used throughout:
--   * every timestamp is timestamptz and stored UTC; display conversion to
--     America/New_York happens in the app, never in the database.
--   * money is an integer count of cents. No floats touch revenue.
--   * controlled vocabularies are CHECK constraints rather than PG enums, so a
--     later migration can widen one with a plain ALTER instead of a type dance.

CREATE TABLE companies (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            text        NOT NULL CHECK (length(btrim(name)) > 0),
    niche           text        NOT NULL DEFAULT '',
    address         text        NOT NULL DEFAULT '',
    city            text        NOT NULL DEFAULT '',
    zip             text        NOT NULL DEFAULT '',
    -- E.164, and the natural key for idempotent CSV re-import.
    phone           text        NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
    google_rating   numeric(2,1)          CHECK (google_rating IS NULL OR (google_rating >= 0 AND google_rating <= 5)),
    review_count    integer               CHECK (review_count IS NULL OR review_count >= 0),
    source          text        NOT NULL DEFAULT 'csv_import',
    tier            text        NOT NULL CHECK (tier IN ('A','B')),
    status          text        NOT NULL DEFAULT 'new'
                                CHECK (status IN ('new','contacted','callback','trial','client','not_interested','dead')),
    notes           text        NOT NULL DEFAULT '',

    -- Soft claim: a 10-minute hold so two people dialing the same list do not
    -- both call the same prospect. Never blocks -- it only reorders the queue
    -- and is surfaced in the UI. Expiry is evaluated at read time, so there is
    -- no sweeper job to fail silently.
    claimed_by      text,
    claimed_at      timestamptz,

    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX companies_phone_key ON companies (phone);
CREATE INDEX companies_queue_idx ON companies (tier, status, created_at);
CREATE INDEX companies_status_idx ON companies (status);
CREATE INDEX companies_niche_idx ON companies (niche);

CREATE TABLE contacts (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id         bigint      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name               text        NOT NULL CHECK (length(btrim(name)) > 0),
    role               text        NOT NULL DEFAULT '',
    phone              text        NOT NULL DEFAULT '',
    preferred_language text        NOT NULL DEFAULT 'es' CHECK (preferred_language IN ('es','en')),
    notes              text        NOT NULL DEFAULT '',
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contacts_company_idx ON contacts (company_id);

CREATE TABLE calls (
    id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id             bigint      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    contact_id             bigint               REFERENCES contacts(id) ON DELETE SET NULL,
    called_by              text        NOT NULL CHECK (length(btrim(called_by)) > 0),
    called_at              timestamptz NOT NULL DEFAULT now(),
    outcome                text        NOT NULL
                                       CHECK (outcome IN ('no_answer','gatekeeper','spoke_to_owner',
                                                          'not_interested','callback','trial_agreed','dead')),
    -- The qualifying number. Required on spoke_to_owner (enforced below and in
    -- the app); meaningless on every other outcome because nobody answered.
    missed_calls_per_week  integer              CHECK (missed_calls_per_week IS NULL OR
                                                      (missed_calls_per_week >= 0 AND missed_calls_per_week <= 500)),
    objection              text        NOT NULL DEFAULT '',
    notes                  text        NOT NULL DEFAULT '',
    callback_at            timestamptz,

    CONSTRAINT calls_missed_required_on_conversation
        CHECK (outcome <> 'spoke_to_owner' OR missed_calls_per_week IS NOT NULL),
    CONSTRAINT calls_callback_requires_time
        CHECK (outcome <> 'callback' OR callback_at IS NOT NULL)
);

CREATE INDEX calls_company_idx  ON calls (company_id, called_at DESC);
CREATE INDEX calls_called_at_idx ON calls (called_at DESC);
CREATE INDEX calls_callback_idx ON calls (callback_at) WHERE callback_at IS NOT NULL;

CREATE TABLE trials (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   bigint      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    started_at   timestamptz NOT NULL DEFAULT now(),
    ends_at      timestamptz NOT NULL,
    installed_by text        NOT NULL DEFAULT '',
    status       text        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','converted','expired','cancelled')),
    notes        text        NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT trials_end_after_start CHECK (ends_at > started_at)
);

CREATE INDEX trials_company_idx ON trials (company_id);
CREATE INDEX trials_status_idx  ON trials (status);

CREATE TABLE clients (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    bigint      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    plan          text        NOT NULL DEFAULT 'missed_call_textback',
    monthly_rate  integer     NOT NULL CHECK (monthly_rate >= 0),   -- cents
    setup_fee     integer     NOT NULL DEFAULT 0 CHECK (setup_fee >= 0), -- cents
    setup_paid    boolean     NOT NULL DEFAULT false,
    started_at    timestamptz NOT NULL DEFAULT now(),
    status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','churned')),
    churned_at    timestamptz,
    churn_reason  text        NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT clients_churn_consistent
        CHECK ((status = 'churned') = (churned_at IS NOT NULL))
);

CREATE INDEX clients_company_idx ON clients (company_id);
CREATE INDEX clients_status_idx  ON clients (status);

CREATE TABLE payments (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id  bigint      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    amount     integer     NOT NULL CHECK (amount > 0),   -- cents
    kind       text        NOT NULL CHECK (kind IN ('setup','monthly')),
    paid_at    timestamptz NOT NULL DEFAULT now(),
    notes      text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payments_client_idx ON payments (client_id);
CREATE INDEX payments_paid_at_idx ON payments (paid_at DESC);

-- Append-only. Every mutating route writes here inside the same transaction as
-- the mutation itself, so a logged action and its effect cannot diverge.
CREATE TABLE activity_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor       text        NOT NULL,
    entity_type text        NOT NULL,
    entity_id   bigint,
    action      text        NOT NULL,
    detail      text        NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_log_entity_idx  ON activity_log (entity_type, entity_id, created_at DESC);
CREATE INDEX activity_log_created_idx ON activity_log (created_at DESC);
