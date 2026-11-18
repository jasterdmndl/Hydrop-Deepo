-- Shared accounts and persistent server-side sessions (AUTH-001, AUTH-003).

CREATE TABLE app_users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username              text NOT NULL,
  username_key          text NOT NULL UNIQUE,  -- lower-cased for lookup
  role                  text NOT NULL CHECK (role IN ('OWNER', 'CASHIER')),
  password_hash         text NOT NULL,          -- Argon2id PHC string
  must_change_password  boolean NOT NULL DEFAULT true,
  password_changed_at   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  disabled_at           timestamptz,
  CHECK (username_key = lower(username))
);

CREATE TABLE auth_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES app_users (id),
  token_hash           text NOT NULL UNIQUE,    -- SHA-256 of the opaque cookie token
  csrf_token           text NOT NULL,
  created_at           timestamptz NOT NULL,
  last_activity_at     timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz,
  revoke_reason        text
);

CREATE INDEX auth_sessions_user_active_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

-- Failed sign-in counters, keyed by account name or client address.
CREATE TABLE login_throttle (
  key                text PRIMARY KEY,
  failures           integer NOT NULL DEFAULT 0,
  window_started_at  timestamptz NOT NULL,
  locked_until       timestamptz
);
