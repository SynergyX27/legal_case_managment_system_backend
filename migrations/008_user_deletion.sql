-- Deleted logins retain historical foreign-key references, but cannot sign in or be selected.
ALTER TABLE legalflow.users ADD COLUMN deleted_at timestamptz;
