-- Run this WHOLE file once in pgAdmin on the existing LegalFlow database.
-- Adds permission settings, staff teams and invoice deletion metadata; preserves all current data.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('legalflow-migrations'));
DO $permissions_update$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM legalflow.migrations WHERE name='003_permissions_and_assignments.sql') THEN
CREATE TABLE legalflow.role_permissions (
 role text PRIMARY KEY CHECK(role IN ('manager','staff')),
 permissions jsonb NOT NULL CHECK(jsonb_typeof(permissions)='object'),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO legalflow.role_permissions(role,permissions) VALUES
 ('manager','{"cases.create":true,"cases.edit":true,"cases.delete":true,"invoices.view":true,"invoices.create":true,"invoices.edit":true,"invoices.delete":true}'),
 ('staff','{"cases.create":false,"cases.edit":true,"cases.delete":false,"invoices.view":false,"invoices.create":false,"invoices.edit":false,"invoices.delete":false}');
ALTER TABLE legalflow.users ADD COLUMN manager_id text REFERENCES legalflow.users(id) ON DELETE RESTRICT;
ALTER TABLE legalflow.users ADD COLUMN permissions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(permissions)='object');
ALTER TABLE legalflow.users ADD CONSTRAINT staff_manager_only CHECK(manager_id IS NULL OR (role='staff' AND manager_id<>id));
CREATE INDEX users_manager ON legalflow.users(manager_id) WHERE manager_id IS NOT NULL;
ALTER TABLE legalflow.invoices ADD COLUMN deleted_at timestamptz;
-- Existing records are retained unchanged. Owners can complete missing legacy assignments.
ALTER TABLE legalflow.cases ADD CONSTRAINT cases_responsible_team CHECK(staff_id IS NOT NULL AND manager_id IS NOT NULL) NOT VALID;

 INSERT INTO legalflow.migrations(name) VALUES('003_permissions_and_assignments.sql');
 END IF;
END $permissions_update$;
COMMIT;

-- Confirm the update. Expected result: 003_permissions_and_assignments.sql
SELECT name FROM legalflow.migrations WHERE name='003_permissions_and_assignments.sql';
