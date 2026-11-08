-- Payment attempts are separate from invoices so webhook retries are idempotent.
CREATE TABLE legalflow.invoice_payments (
 id text PRIMARY KEY,
 invoice_id text NOT NULL REFERENCES legalflow.invoices(id) ON DELETE RESTRICT,
 user_id text NOT NULL REFERENCES legalflow.users(id),
 amount_cents bigint NOT NULL CHECK(amount_cents > 0),
 currency text NOT NULL CHECK(currency='usd'),
 status text NOT NULL CHECK(status IN ('creating','open','processing','paid','expired')),
 checkout_parameters jsonb NOT NULL,
 stripe_session_id text UNIQUE,
 stripe_payment_intent_id text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 paid_at timestamptz
);
CREATE UNIQUE INDEX one_active_invoice_checkout ON legalflow.invoice_payments(invoice_id) WHERE status IN ('creating','open','processing');
CREATE UNIQUE INDEX one_online_payment_per_invoice ON legalflow.invoice_payments(invoice_id) WHERE status='paid';
CREATE INDEX invoice_payment_history ON legalflow.invoice_payments(invoice_id,created_at DESC);
CREATE TABLE legalflow.stripe_events (
 id text PRIMARY KEY,
 type text NOT NULL,
 processed_at timestamptz NOT NULL DEFAULT now()
);
