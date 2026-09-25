-- Prospect import from a phone.
--
-- A web import is two requests -- check the file, then confirm -- and the app
-- ships no client-side JavaScript to hold the file in between. So the checked
-- file waits here. Confirming re-validates from csv_text rather than trusting
-- anything stored alongside it. Batches are purged after 7 days; the
-- activity_log row written on import is the permanent record.

CREATE TABLE import_batches (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_by     text        NOT NULL CHECK (length(btrim(created_by)) > 0),
    filename       text        NOT NULL DEFAULT '',
    source         text        NOT NULL DEFAULT 'csv_import',
    csv_text       text        NOT NULL,
    total_rows     integer     NOT NULL DEFAULT 0,
    valid_rows     integer     NOT NULL DEFAULT 0,
    rejected_rows  integer     NOT NULL DEFAULT 0,
    status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','imported','discarded')),
    created_count  integer,
    updated_count  integer,
    created_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,
    CONSTRAINT import_batches_finished_consistent CHECK ((status = 'pending') = (finished_at IS NULL))
);

CREATE INDEX import_batches_created_idx ON import_batches (created_at);
