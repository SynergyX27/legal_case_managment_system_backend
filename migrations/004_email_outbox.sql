CREATE TABLE legalflow.email_outbox (
 id text PRIMARY KEY,
 event_key text NOT NULL,
 to_email text NOT NULL,
 subject text NOT NULL,
 text_body text NOT NULL,
 html_body text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed')),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token text,
 leased_at timestamptz,
 sent_at timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(event_key,to_email)
);
CREATE INDEX email_outbox_due ON legalflow.email_outbox(next_attempt_at,created_at) WHERE state IN ('pending','sending');
