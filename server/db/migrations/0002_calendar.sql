-- One-time Activity Calendar occurrences and completions (CAL-001, CAL-002, CAL-003).

CREATE TABLE calendar_occurrences (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text NOT NULL UNIQUE,
  request_key         text NOT NULL UNIQUE,
  name                text NOT NULL,
  scheduled_at        timestamptz NOT NULL,
  schedule_notes      text,
  created_by_user_id  uuid NOT NULL REFERENCES app_users (id),
  created_at          timestamptz NOT NULL
);

CREATE INDEX calendar_occurrences_scheduled_at_idx
  ON calendar_occurrences (scheduled_at, reference);

CREATE TABLE calendar_completions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id        uuid NOT NULL UNIQUE REFERENCES calendar_occurrences (id),
  actual_completed_at  timestamptz NOT NULL,
  completion_notes     text NOT NULL,
  recorded_by_user_id  uuid NOT NULL REFERENCES app_users (id),
  recorded_at          timestamptz NOT NULL
);

CREATE INDEX calendar_completions_actual_completed_at_idx
  ON calendar_completions (actual_completed_at DESC);
