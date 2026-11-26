-- LegalFlow combined update: previous E2 changes + workspaces + email conversations.
-- Select the SAME database as backend DATABASE_URL. Run the WHOLE file.
-- Existing users, cases, documents, invoices and payments are preserved.
-- If pgAdmin says transaction aborted, run ROLLBACK; by itself, then run this file.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('legalflow-migrations'));
DO $combined_update$
BEGIN
IF NOT EXISTS(SELECT 1 FROM legalflow.migrations WHERE name='006_case_property_and_branding.sql') THEN
CREATE SEQUENCE IF NOT EXISTS legalflow.case_ref_numbers;
ALTER TABLE legalflow.email_outbox ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
WITH candidates AS MATERIALIZED (
 SELECT id,created_at,CASE lower(trim(data->>'state')) WHEN 'alabama' THEN 'AL' WHEN 'al' THEN 'AL' WHEN 'alaska' THEN 'AK' WHEN 'ak' THEN 'AK' WHEN 'arizona' THEN 'AZ' WHEN 'az' THEN 'AZ' WHEN 'arkansas' THEN 'AR' WHEN 'ar' THEN 'AR' WHEN 'california' THEN 'CA' WHEN 'ca' THEN 'CA' WHEN 'colorado' THEN 'CO' WHEN 'co' THEN 'CO' WHEN 'connecticut' THEN 'CT' WHEN 'ct' THEN 'CT' WHEN 'delaware' THEN 'DE' WHEN 'de' THEN 'DE' WHEN 'florida' THEN 'FL' WHEN 'fl' THEN 'FL' WHEN 'georgia' THEN 'GA' WHEN 'ga' THEN 'GA' WHEN 'hawaii' THEN 'HI' WHEN 'hi' THEN 'HI' WHEN 'idaho' THEN 'ID' WHEN 'id' THEN 'ID' WHEN 'illinois' THEN 'IL' WHEN 'il' THEN 'IL' WHEN 'indiana' THEN 'IN' WHEN 'in' THEN 'IN' WHEN 'iowa' THEN 'IA' WHEN 'ia' THEN 'IA' WHEN 'kansas' THEN 'KS' WHEN 'ks' THEN 'KS' WHEN 'kentucky' THEN 'KY' WHEN 'ky' THEN 'KY' WHEN 'louisiana' THEN 'LA' WHEN 'la' THEN 'LA' WHEN 'maine' THEN 'ME' WHEN 'me' THEN 'ME' WHEN 'maryland' THEN 'MD' WHEN 'md' THEN 'MD' WHEN 'massachusetts' THEN 'MA' WHEN 'ma' THEN 'MA' WHEN 'michigan' THEN 'MI' WHEN 'mi' THEN 'MI' WHEN 'minnesota' THEN 'MN' WHEN 'mn' THEN 'MN' WHEN 'mississippi' THEN 'MS' WHEN 'ms' THEN 'MS' WHEN 'missouri' THEN 'MO' WHEN 'mo' THEN 'MO' WHEN 'montana' THEN 'MT' WHEN 'mt' THEN 'MT' WHEN 'nebraska' THEN 'NE' WHEN 'ne' THEN 'NE' WHEN 'nevada' THEN 'NV' WHEN 'nv' THEN 'NV' WHEN 'new hampshire' THEN 'NH' WHEN 'nh' THEN 'NH' WHEN 'new jersey' THEN 'NJ' WHEN 'nj' THEN 'NJ' WHEN 'new mexico' THEN 'NM' WHEN 'nm' THEN 'NM' WHEN 'new york' THEN 'NY' WHEN 'ny' THEN 'NY' WHEN 'north carolina' THEN 'NC' WHEN 'nc' THEN 'NC' WHEN 'north dakota' THEN 'ND' WHEN 'nd' THEN 'ND' WHEN 'ohio' THEN 'OH' WHEN 'oh' THEN 'OH' WHEN 'oklahoma' THEN 'OK' WHEN 'ok' THEN 'OK' WHEN 'oregon' THEN 'OR' WHEN 'or' THEN 'OR' WHEN 'pennsylvania' THEN 'PA' WHEN 'pa' THEN 'PA' WHEN 'rhode island' THEN 'RI' WHEN 'ri' THEN 'RI' WHEN 'south carolina' THEN 'SC' WHEN 'sc' THEN 'SC' WHEN 'south dakota' THEN 'SD' WHEN 'sd' THEN 'SD' WHEN 'tennessee' THEN 'TN' WHEN 'tn' THEN 'TN' WHEN 'texas' THEN 'TX' WHEN 'tx' THEN 'TX' WHEN 'utah' THEN 'UT' WHEN 'ut' THEN 'UT' WHEN 'vermont' THEN 'VT' WHEN 'vt' THEN 'VT' WHEN 'virginia' THEN 'VA' WHEN 'va' THEN 'VA' WHEN 'washington' THEN 'WA' WHEN 'wa' THEN 'WA' WHEN 'west virginia' THEN 'WV' WHEN 'wv' THEN 'WV' WHEN 'wisconsin' THEN 'WI' WHEN 'wi' THEN 'WI' WHEN 'wyoming' THEN 'WY' WHEN 'wy' THEN 'WY' WHEN 'district of columbia' THEN 'DC' WHEN 'dc' THEN 'DC' END AS territory,nextval('legalflow.case_ref_numbers')::text AS seq
 FROM legalflow.cases WHERE coalesce(data->>'refId','')=''
), references_to_add AS (
 SELECT id,territory||to_char(created_at AT TIME ZONE 'UTC','YY')||'-'||lpad(seq,greatest(5,length(seq)),'0') AS ref_id FROM candidates WHERE territory IS NOT NULL
)
UPDATE legalflow.cases c SET data=c.data||jsonb_build_object('refId',r.ref_id) FROM references_to_add r WHERE c.id=r.id;
CREATE UNIQUE INDEX IF NOT EXISTS cases_ref_id_unique ON legalflow.cases((data->>'refId')) WHERE coalesce(data->>'refId','')<>'';

INSERT INTO legalflow.migrations(name) VALUES('006_case_property_and_branding.sql');
END IF;
IF NOT EXISTS(SELECT 1 FROM legalflow.migrations WHERE name='007_workspaces_and_email.sql') THEN
ALTER TABLE legalflow.users DROP CONSTRAINT IF EXISTS users_client_id_key;
ALTER TABLE legalflow.users ADD COLUMN customer_access text NOT NULL DEFAULT 'all' CHECK(customer_access IN('all','regional','community'));
CREATE INDEX users_client ON legalflow.users(client_id);
CREATE TABLE legalflow.workspaces(
 id text PRIMARY KEY,client_id text NOT NULL REFERENCES legalflow.clients(id),parent_id text REFERENCES legalflow.workspaces(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN('territory','community')),name text NOT NULL CHECK(length(trim(name))>0),state text NOT NULL DEFAULT '',
 archived boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='territory' AND parent_id IS NULL) OR(kind='community' AND parent_id IS NOT NULL)));
CREATE UNIQUE INDEX workspaces_name ON legalflow.workspaces(client_id,coalesce(parent_id,''),lower(name)) WHERE NOT archived;
CREATE INDEX workspaces_parent ON legalflow.workspaces(parent_id);
CREATE TABLE legalflow.workspace_members(workspace_id text NOT NULL REFERENCES legalflow.workspaces(id) ON DELETE CASCADE,user_id text NOT NULL REFERENCES legalflow.users(id) ON DELETE CASCADE,PRIMARY KEY(workspace_id,user_id));
ALTER TABLE legalflow.cases ADD COLUMN workspace_id text REFERENCES legalflow.workspaces(id) ON DELETE RESTRICT;
CREATE INDEX cases_workspace ON legalflow.cases(workspace_id);
CREATE TABLE legalflow.email_threads(id text PRIMARY KEY,case_id text NOT NULL REFERENCES legalflow.cases(id) ON DELETE RESTRICT,customer_user_id text NOT NULL REFERENCES legalflow.users(id),subject text NOT NULL,created_by text NOT NULL REFERENCES legalflow.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX email_threads_case ON legalflow.email_threads(case_id);
CREATE TABLE legalflow.email_messages(id text PRIMARY KEY,thread_id text NOT NULL REFERENCES legalflow.email_threads(id) ON DELETE CASCADE,direction text NOT NULL CHECK(direction IN('outgoing','incoming')),channel text NOT NULL DEFAULT 'email',sender_id text REFERENCES legalflow.users(id),from_email text NOT NULL,to_email text NOT NULL,body text NOT NULL,request_fingerprint text,message_id text NOT NULL UNIQUE,outbox_id text REFERENCES legalflow.email_outbox(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX email_messages_thread ON legalflow.email_messages(thread_id,created_at);
CREATE TABLE legalflow.email_reads(thread_id text NOT NULL REFERENCES legalflow.email_threads(id) ON DELETE CASCADE,user_id text NOT NULL REFERENCES legalflow.users(id) ON DELETE CASCADE,last_read_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(thread_id,user_id));
CREATE TABLE legalflow.email_attachments(id text PRIMARY KEY,message_id text NOT NULL REFERENCES legalflow.email_messages(id) ON DELETE CASCADE,name text NOT NULL,mime text NOT NULL,bytes integer NOT NULL,payload bytea,dropbox_path text NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','ready')),attempts integer NOT NULL DEFAULT 0,last_error text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE legalflow.email_sync_state(id text PRIMARY KEY,uid_validity text NOT NULL DEFAULT '',last_uid bigint NOT NULL DEFAULT 0,last_sync_at timestamptz,last_error text,ignored integer NOT NULL DEFAULT 0);
ALTER TABLE legalflow.email_outbox ADD COLUMN mail_headers jsonb NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO legalflow.migrations(name) VALUES('007_workspaces_and_email.sql');
END IF;
END $combined_update$;
DO $user_deletion$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM legalflow.migrations WHERE name='008_user_deletion.sql') THEN
 ALTER TABLE legalflow.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
 INSERT INTO legalflow.migrations(name) VALUES('008_user_deletion.sql');
 END IF;
END $user_deletion$;
COMMIT;
SELECT name FROM legalflow.migrations WHERE name IN('006_case_property_and_branding.sql','007_workspaces_and_email.sql') ORDER BY name;
SELECT to_regclass('legalflow.workspaces') AS workspaces,to_regclass('legalflow.email_threads') AS email_threads,to_regclass('legalflow.case_ref_numbers') AS reference_sequence;

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
