CREATE TABLE legalflow.mobile_sessions (
 id text PRIMARY KEY,
 token_hash text NOT NULL UNIQUE,
 user_id text NOT NULL REFERENCES legalflow.users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mobile_sessions_user ON legalflow.mobile_sessions(user_id);
CREATE TABLE legalflow.mobile_oauth_states (
 state_hash text PRIMARY KEY,
 session_id text NOT NULL REFERENCES legalflow.mobile_sessions(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
