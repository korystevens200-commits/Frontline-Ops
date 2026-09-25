-- Frontline Ops Phase 2: missed-call text-back.
--
-- Everything here is additive. No Phase 1 table is altered, so the Phase 1
-- code runs unchanged against this schema and rolling back is a redeploy.
--
-- The tenant is the business being served -- a row in companies. Every
-- delivery row carries company_id AND line_id, and composite foreign keys tie
-- them together, so the database itself refuses a message filed under one
-- business on another business's line. Conversations and messages are tied to
-- their line the same way.
--
-- Same conventions as 001: timestamptz stored UTC, controlled vocabularies as
-- CHECK constraints, phone numbers in E.164.

-- Languages are rows rather than a CHECK list so adding one (Portuguese is
-- next) is an INSERT in a migration plus a module in src/delivery/language/,
-- with no constraint to rewrite on every table that stores a language.
CREATE TABLE languages (
    code  text PRIMARY KEY CHECK (code ~ '^[a-z]{2}$'),
    name  text NOT NULL
);

INSERT INTO languages (code, name) VALUES ('en', 'English'), ('es', 'Español');

-- A client's dedicated number. "Line" rather than "number" because it is the
-- whole delivery setup: the number, who it texts as, who gets alerted.
CREATE TABLE lines (
    id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id              bigint      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    number                  text        NOT NULL CHECK (number ~ '^\+[1-9][0-9]{7,14}$'),
    provider                text        NOT NULL DEFAULT 'twilio',
    provider_number_sid     text        NOT NULL DEFAULT '',
    -- Empty means the server-wide default. Per line so each client can later
    -- sit on its own registered A2P campaign.
    messaging_service_sid   text        NOT NULL DEFAULT '',
    -- The number customers actually dial, which forwards here on no-answer.
    business_number         text        NOT NULL DEFAULT ''
                                        CHECK (business_number = '' OR business_number ~ '^\+[1-9][0-9]{7,14}$'),
    -- How the business is named inside every text and greeting.
    display_name            text        NOT NULL CHECK (length(btrim(display_name)) > 0),
    -- First contact goes out in the primary language, followed by the
    -- secondary one when set. A caller whose language is already known gets
    -- theirs alone.
    primary_language        text        NOT NULL DEFAULT 'en' REFERENCES languages(code),
    secondary_language      text                 DEFAULT 'es' REFERENCES languages(code),
    alert_phone             text        NOT NULL DEFAULT ''
                                        CHECK (alert_phone = '' OR alert_phone ~ '^\+[1-9][0-9]{7,14}$'),
    alert_language          text        NOT NULL DEFAULT 'es' REFERENCES languages(code),
    followup_enabled        boolean     NOT NULL DEFAULT true,
    followup_delay_minutes  integer     NOT NULL DEFAULT 60 CHECK (followup_delay_minutes BETWEEN 5 AND 1440),
    -- Ceiling on outbound texts in any rolling 24 hours: a runaway loop or a
    -- robocall flood costs at most this much.
    daily_send_cap          integer     NOT NULL DEFAULT 200 CHECK (daily_send_cap BETWEEN 1 AND 5000),
    timezone                text        NOT NULL DEFAULT 'America/New_York',
    -- Always on, whatever the trial says: for showing prospects the product
    -- and for testing. Labelled everywhere it appears.
    is_demo                 boolean     NOT NULL DEFAULT false,
    status                  text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','released')),
    forwarding_verified_at  timestamptz,
    last_call_at            timestamptz,
    created_by              text        NOT NULL CHECK (length(btrim(created_by)) > 0),
    created_at              timestamptz NOT NULL DEFAULT now(),
    paused_at               timestamptz,
    released_at             timestamptz,

    CONSTRAINT lines_languages_differ CHECK (secondary_language IS NULL OR secondary_language <> primary_language),
    CONSTRAINT lines_release_consistent CHECK ((status = 'released') = (released_at IS NOT NULL)),
    CONSTRAINT lines_id_company_key UNIQUE (id, company_id)
);

-- A released number can be bought again later by someone else; only live
-- lines need to be unique. One live line per business.
CREATE UNIQUE INDEX lines_number_live_key ON lines (number) WHERE status <> 'released';
CREATE UNIQUE INDEX lines_one_live_per_company ON lines (company_id) WHERE status <> 'released';

-- Per-client wording. The default text lives in code; a row here replaces the
-- body for one language. The business name is always added by the app.
CREATE TABLE line_templates (
    line_id     bigint      NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
    key         text        NOT NULL CHECK (key IN ('textback','followup')),
    language    text        NOT NULL REFERENCES languages(code),
    body        text        NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 300),
    updated_by  text        NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (line_id, key, language)
);

-- One thread per caller per line. Everything the caller and the service say
-- to each other hangs off this.
CREATE TABLE conversations (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id        bigint      NOT NULL,
    line_id           bigint      NOT NULL,
    lead_phone        text        NOT NULL CHECK (lead_phone ~ '^\+[1-9][0-9]{7,14}$'),
    language          text                 REFERENCES languages(code),
    -- open: called and/or texted, no reply yet. replied: the customer wrote
    -- back and the owner should act. closed: handled.
    status            text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','replied','closed')),
    opted_out_at      timestamptz,
    first_call_at     timestamptz,
    last_call_at      timestamptz,
    call_count        integer     NOT NULL DEFAULT 0 CHECK (call_count >= 0),
    last_textback_at  timestamptz,
    first_reply_at    timestamptz,
    last_inbound_at   timestamptz,
    last_outbound_at  timestamptz,
    last_activity_at  timestamptz NOT NULL DEFAULT now(),
    followup_due_at   timestamptz,
    followups_sent    integer     NOT NULL DEFAULT 0 CHECK (followups_sent >= 0),
    last_alert_at     timestamptz,
    closed_at         timestamptz,
    closed_by         text,
    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT conversations_line_fk FOREIGN KEY (line_id, company_id)
        REFERENCES lines (id, company_id) ON DELETE CASCADE,
    CONSTRAINT conversations_line_lead_key UNIQUE (line_id, lead_phone),
    CONSTRAINT conversations_id_line_key UNIQUE (id, line_id),
    CONSTRAINT conversations_closed_consistent CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE INDEX conversations_activity_idx ON conversations (last_activity_at DESC);
CREATE INDEX conversations_company_idx  ON conversations (company_id, last_activity_at DESC);
CREATE INDEX conversations_status_idx   ON conversations (status, last_activity_at DESC);
CREATE INDEX conversations_followup_idx ON conversations (followup_due_at) WHERE followup_due_at IS NOT NULL;

-- Every SMS in either direction, and the outbox: an outbound row starts
-- 'queued' and the dispatcher moves it along. Rows are never deleted.
CREATE TABLE messages (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id       bigint      NOT NULL,
    line_id          bigint      NOT NULL,
    conversation_id  bigint,
    direction        text        NOT NULL CHECK (direction IN ('inbound','outbound')),
    kind             text        NOT NULL CHECK (kind IN (
                                   'reply','optout','optin',                                  -- inbound
                                   'textback','followup','owner_alert','optout_confirm','test' -- outbound
                                 )),
    from_number      text        NOT NULL,
    to_number        text        NOT NULL,
    body             text        NOT NULL DEFAULT '',
    language         text                 REFERENCES languages(code),
    encoding         text        NOT NULL DEFAULT 'GSM-7' CHECK (encoding IN ('GSM-7','UCS-2')),
    segments         integer     NOT NULL DEFAULT 1 CHECK (segments >= 1),
    media_count      integer     NOT NULL DEFAULT 0 CHECK (media_count >= 0),
    provider_sid     text        UNIQUE,
    status           text        NOT NULL CHECK (status IN (
                                   'queued','sending','sent','delivered','undelivered',
                                   'failed','unknown','cancelled','received')),
    error_code       text        NOT NULL DEFAULT '',
    error_message    text        NOT NULL DEFAULT '',
    attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at  timestamptz,
    last_attempt_at  timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    sent_at          timestamptz,
    delivered_at     timestamptz,

    CONSTRAINT messages_line_fk FOREIGN KEY (line_id, company_id)
        REFERENCES lines (id, company_id) ON DELETE CASCADE,
    CONSTRAINT messages_conversation_fk FOREIGN KEY (conversation_id, line_id)
        REFERENCES conversations (id, line_id) ON DELETE CASCADE,
    CONSTRAINT messages_inbound_received CHECK ((direction = 'inbound') = (status = 'received')),
    CONSTRAINT messages_kind_direction CHECK (
        (direction = 'inbound'  AND kind IN ('reply','optout','optin')) OR
        (direction = 'outbound' AND kind IN ('textback','followup','owner_alert','optout_confirm','test'))),
    CONSTRAINT messages_queued_has_time CHECK (status <> 'queued' OR next_attempt_at IS NOT NULL)
);

CREATE INDEX messages_outbox_idx       ON messages (next_attempt_at, id) WHERE status = 'queued';
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);
CREATE INDEX messages_line_created_idx ON messages (line_id, created_at DESC);
CREATE INDEX messages_created_idx      ON messages (created_at DESC);

-- Every call that reached a line. By the way forwarding is set up, reaching
-- the line at all means the business did not pick up.
CREATE TABLE missed_calls (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id           bigint      NOT NULL,
    line_id              bigint      NOT NULL,
    conversation_id      bigint,
    -- Twilio retries a webhook it did not get an answer to. The unique call id
    -- makes a retry a no-op rather than a second text.
    provider_call_sid    text        NOT NULL UNIQUE,
    from_number          text        NOT NULL DEFAULT '',
    forwarded_from       text        NOT NULL DEFAULT '',
    -- STIR/SHAKEN attestation as the carrier reported it.
    caller_verification  text        NOT NULL DEFAULT '',
    decision             text        NOT NULL CHECK (decision IN (
                                       'texted','duplicate','opted_out','not_entitled','paused',
                                       'no_caller_id','spam_suspected','cap_reached')),
    message_id           bigint               REFERENCES messages(id) ON DELETE SET NULL,
    received_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT missed_calls_line_fk FOREIGN KEY (line_id, company_id)
        REFERENCES lines (id, company_id) ON DELETE CASCADE,
    CONSTRAINT missed_calls_conversation_fk FOREIGN KEY (conversation_id, line_id)
        REFERENCES conversations (id, line_id) ON DELETE CASCADE
);

CREATE INDEX missed_calls_line_idx         ON missed_calls (line_id, received_at DESC);
CREATE INDEX missed_calls_conversation_idx ON missed_calls (conversation_id, received_at);
CREATE INDEX missed_calls_received_idx     ON missed_calls (received_at DESC);

-- Raw webhook payloads that passed signature checks, for answering "what did
-- Twilio actually send us?" They carry customer text, so they are purged
-- after 30 days by the dispatcher's maintenance pass.
CREATE TABLE provider_events (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider      text        NOT NULL,
    kind          text        NOT NULL,
    provider_sid  text        NOT NULL DEFAULT '',
    line_id       bigint               REFERENCES lines(id) ON DELETE SET NULL,
    outcome       text        NOT NULL DEFAULT '',
    payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX provider_events_received_idx ON provider_events (received_at);

-- Fixed-window counters for rate limits. In Postgres rather than memory so a
-- limit holds across every machine Fly runs.
CREATE TABLE rate_limits (
    bucket        text        NOT NULL,
    key           text        NOT NULL,
    window_start  timestamptz NOT NULL,
    hits          integer     NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, key, window_start)
);
