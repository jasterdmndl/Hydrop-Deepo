-- Final Activity Calendar Task 2: durable versioned edits, schedule history,
-- cancellation records, and idempotent mutation requests (CAL-001, CAL-003, DEC-108, DEC-110, DEC-112, DEC-067).

ALTER TABLE calendar_occurrences
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);

ALTER TABLE calendar_occurrences
  ADD COLUMN original_name text;

ALTER TABLE calendar_occurrences
  ADD COLUMN original_scheduled_at timestamptz;

ALTER TABLE calendar_occurrences
  ADD COLUMN original_schedule_notes text;

UPDATE calendar_occurrences
   SET original_name = name,
       original_scheduled_at = scheduled_at,
       original_schedule_notes = schedule_notes
 WHERE original_name IS NULL
    OR original_scheduled_at IS NULL;

ALTER TABLE calendar_occurrences
  ALTER COLUMN original_name SET NOT NULL;

ALTER TABLE calendar_occurrences
  ALTER COLUMN original_scheduled_at SET NOT NULL;

ALTER TABLE calendar_occurrences
  ADD COLUMN cancelled_at timestamptz;

ALTER TABLE calendar_occurrences
  ADD COLUMN cancelled_by_user_id uuid REFERENCES app_users (id);

ALTER TABLE calendar_occurrences
  ADD COLUMN cancellation_reason text;

ALTER TABLE calendar_occurrences
  ADD CONSTRAINT calendar_occurrences_cancellation_fields_check
  CHECK (
    (cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancellation_reason IS NULL)
    OR (
      cancelled_at IS NOT NULL
      AND cancelled_by_user_id IS NOT NULL
      AND cancellation_reason IS NOT NULL
      AND length(btrim(cancellation_reason)) > 0
    )
  );

CREATE INDEX calendar_occurrences_series_order_idx
  ON calendar_occurrences (series_id, series_index, scheduled_at, reference)
  WHERE series_id IS NOT NULL;

CREATE TABLE calendar_occurrence_changes (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id           uuid NOT NULL REFERENCES calendar_occurrences (id),
  change_type             text NOT NULL CHECK (change_type IN ('EDIT', 'CANCEL')),
  scope                   text NOT NULL CHECK (scope IN ('THIS_OCCURRENCE', 'THIS_AND_FUTURE')),
  request_key             text NOT NULL,
  previous_name           text NOT NULL,
  new_name                text NOT NULL,
  previous_scheduled_at   timestamptz NOT NULL,
  new_scheduled_at        timestamptz NOT NULL,
  previous_schedule_notes text,
  new_schedule_notes      text,
  reason                  text,
  changed_by_user_id      uuid NOT NULL REFERENCES app_users (id),
  changed_at              timestamptz NOT NULL
);

CREATE INDEX calendar_occurrence_changes_occ_idx
  ON calendar_occurrence_changes (occurrence_id, changed_at ASC, id ASC);

ALTER TABLE calendar_occurrence_changes ENABLE ROW LEVEL SECURITY;

CREATE TABLE calendar_mutation_requests (
  request_key         text PRIMARY KEY,
  operation           text NOT NULL CHECK (operation IN ('EDIT', 'CANCEL')),
  target_reference    text NOT NULL,
  scope               text NOT NULL CHECK (scope IN ('THIS_OCCURRENCE', 'THIS_AND_FUTURE')),
  payload_fingerprint text NOT NULL,
  response_status     integer NOT NULL,
  affected_references jsonb NOT NULL,
  created_by_user_id  uuid NOT NULL REFERENCES app_users (id),
  created_at          timestamptz NOT NULL
);

ALTER TABLE calendar_mutation_requests ENABLE ROW LEVEL SECURITY;
