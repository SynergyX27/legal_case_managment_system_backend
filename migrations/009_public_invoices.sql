CREATE TABLE legalflow.invoice_public_links (
 token_hash text PRIMARY KEY,
 invoice_id text NOT NULL REFERENCES legalflow.invoices(id) ON DELETE CASCADE,
 created_by text REFERENCES legalflow.users(id) ON DELETE SET NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_public_links_invoice ON legalflow.invoice_public_links(invoice_id);
