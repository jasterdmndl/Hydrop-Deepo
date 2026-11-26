-- Final Activity Calendar Task 3: auditable completion corrections
-- (CAL-001, CAL-002, DEC-108, DEC-112, DEC-067).

ALTER TABLE calendar_completions
  ADD COLUMN original_actual_completed_at timestamptz;

ALTER TABLE calendar_completions
  ADD COLUMN original_completion_notes text;

UPDATE calendar_completions
   SET original_actual_completed_at = actual_completed_at,
       original_completion_notes = completion_notes
 WHERE original_actual_completed_at IS NULL
    OR original_completion_notes IS NULL;

ALTER TABLE calendar_completions
  ALTER COLUMN original_actual_completed_at SET NOT NULL;

ALTER TABLE calendar_completions
  ALTER COLUMN original_completion_notes SET NOT NULL;

CREATE TABLE calendar_completion_corrections (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id                uuid NOT NULL REFERENCES calendar_occurrences (id),
  resulting_version            integer NOT NULL CHECK (resulting_version >= 2),
  request_key                  text NOT NULL,
  previous_actual_completed_at timestamptz NOT NULL,
  new_actual_completed_at      timestamptz NOT NULL,
  previous_completion_notes    text NOT NULL,
  new_completion_notes         text NOT NULL,
  reason                       text NOT NULL CHECK (length(btrim(reason)) > 0),
  corrected_by_user_id         uuid NOT NULL REFERENCES app_users (id),
  corrected_at                 timestamptz NOT NULL,
  UNIQUE (occurrence_id, resulting_version)
);

CREATE INDEX calendar_completion_corrections_occ_version_idx
  ON calendar_completion_corrections (occurrence_id, resulting_version ASC);

ALTER TABLE calendar_completion_corrections ENABLE ROW LEVEL SECURITY;

ALTER TABLE calendar_mutation_requests
  DROP CONSTRAINT IF EXISTS calendar_mutation_requests_operation_check;

ALTER TABLE calendar_mutation_requests
  ADD CONSTRAINT calendar_mutation_requests_operation_check
  CHECK (operation IN ('EDIT', 'CANCEL', 'CORRECT_COMPLETION'));
