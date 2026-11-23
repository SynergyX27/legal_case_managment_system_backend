-- Run the whole file in your existing LegalFlow database before deploying.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('legalflow-migrations'));
DO $user_deletion$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM legalflow.migrations WHERE name='008_user_deletion.sql') THEN
 ALTER TABLE legalflow.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
 INSERT INTO legalflow.migrations(name) VALUES('008_user_deletion.sql');
 END IF;
END $user_deletion$;
COMMIT;
SELECT name FROM legalflow.migrations WHERE name='008_user_deletion.sql';
