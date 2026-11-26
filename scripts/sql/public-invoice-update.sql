-- Run this whole file in your existing LegalFlow database before deploying.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('legalflow-migrations'));
DO $public_invoice_update$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM legalflow.migrations WHERE name='009_public_invoices.sql') THEN
CREATE TABLE legalflow.invoice_public_links (
 token_hash text PRIMARY KEY,
 invoice_id text NOT NULL REFERENCES legalflow.invoices(id) ON DELETE CASCADE,
 created_by text REFERENCES legalflow.users(id) ON DELETE SET NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_public_links_invoice ON legalflow.invoice_public_links(invoice_id);

INSERT INTO legalflow.migrations(name) VALUES('009_public_invoices.sql');
 END IF;
END $public_invoice_update$;
COMMIT;
SELECT name FROM legalflow.migrations WHERE name='009_public_invoices.sql';
