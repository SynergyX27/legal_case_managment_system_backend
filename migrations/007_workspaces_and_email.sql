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
