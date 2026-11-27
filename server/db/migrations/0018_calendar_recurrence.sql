-- Final Activity Calendar Task 1: repeating activity series and durable schedule request records
-- (CAL-001, CAL-003, DEC-112, DEC-067).

CREATE TABLE calendar_series (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference              text NOT NULL UNIQUE,
  recurrence             text NOT NULL CHECK (recurrence IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  start_date             date NOT NULL,
  end_date               date NOT NULL CHECK (end_date >= start_date),
  scheduled_time         text NOT NULL,
  preferred_day_of_month integer CHECK (preferred_day_of_month IS NULL OR (preferred_day_of_month >= 1 AND preferred_day_of_month <= 31)),
  weekday                integer CHECK (weekday IS NULL OR (weekday >= 0 AND weekday <= 6)),
  created_by_user_id     uuid NOT NULL REFERENCES app_users (id),
  created_at             timestamptz NOT NULL,
  CHECK (
    (recurrence = 'DAILY' AND preferred_day_of_month IS NULL AND weekday IS NULL)
    OR (recurrence = 'WEEKLY' AND preferred_day_of_month IS NULL AND weekday IS NOT NULL)
    OR (recurrence = 'MONTHLY' AND preferred_day_of_month IS NOT NULL AND weekday IS NULL)
  )
);

ALTER TABLE calendar_series ENABLE ROW LEVEL SECURITY;

ALTER TABLE calendar_occurrences
  ALTER COLUMN request_key DROP NOT NULL;

ALTER TABLE calendar_occurrences
  ADD COLUMN series_id uuid REFERENCES calendar_series (id);

ALTER TABLE calendar_occurrences
  ADD COLUMN series_index integer CHECK (series_index IS NULL OR series_index >= 1);

ALTER TABLE calendar_occurrences
  ADD CONSTRAINT calendar_occurrences_series_membership_check
  CHECK (
    (series_id IS NULL AND series_index IS NULL)
    OR (series_id IS NOT NULL AND series_index IS NOT NULL)
  );

CREATE UNIQUE INDEX calendar_occurrences_series_index_uidx
  ON calendar_occurrences (series_id, series_index)
  WHERE series_id IS NOT NULL;

CREATE TABLE calendar_schedule_requests (
  request_key           text PRIMARY KEY,
  recurrence            text NOT NULL CHECK (recurrence IN ('ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY')),
  name                  text NOT NULL,
  scheduled_at          timestamptz NOT NULL,
  end_date              date,
  schedule_notes        text,
  series_id             uuid REFERENCES calendar_series (id),
  occurrence_references jsonb NOT NULL,
  created_by_user_id    uuid NOT NULL REFERENCES app_users (id),
  created_at            timestamptz NOT NULL,
  CHECK (
    (recurrence = 'ONE_TIME' AND end_date IS NULL AND series_id IS NULL)
    OR (recurrence <> 'ONE_TIME' AND end_date IS NOT NULL AND series_id IS NOT NULL)
  )
);

ALTER TABLE calendar_schedule_requests ENABLE ROW LEVEL SECURITY;
