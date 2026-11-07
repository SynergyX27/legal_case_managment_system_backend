CREATE SCHEMA IF NOT EXISTS legalflow;
CREATE TABLE legalflow.clients(id text PRIMARY KEY,data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE legalflow.users(
 id text PRIMARY KEY,name text NOT NULL,email text NOT NULL,username text NOT NULL,password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','manager','staff','customer')),status text NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Inactive')),
 client_id text UNIQUE REFERENCES legalflow.clients(id) ON DELETE RESTRICT,phone text NOT NULL DEFAULT '',title text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),last_login timestamptz,
 CHECK((role='customer')=(client_id IS NOT NULL))
);
CREATE UNIQUE INDEX users_email_ci ON legalflow.users(lower(email));
CREATE UNIQUE INDEX users_username_ci ON legalflow.users(lower(username));
CREATE TABLE legalflow.cases(id text PRIMARY KEY,number text NOT NULL UNIQUE,client_id text NOT NULL REFERENCES legalflow.clients(id),staff_id text REFERENCES legalflow.users(id),manager_id text REFERENCES legalflow.users(id),data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX cases_number_ci ON legalflow.cases(lower(number));
CREATE INDEX cases_client ON legalflow.cases(client_id);CREATE INDEX cases_staff ON legalflow.cases(staff_id);CREATE INDEX cases_manager ON legalflow.cases(manager_id);
CREATE SEQUENCE legalflow.invoice_numbers;
CREATE TABLE legalflow.invoices(id text PRIMARY KEY,number text NOT NULL UNIQUE,case_id text NOT NULL REFERENCES legalflow.cases(id) ON DELETE RESTRICT,client_id text NOT NULL REFERENCES legalflow.clients(id),data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX invoices_case ON legalflow.invoices(case_id);
CREATE TABLE legalflow.events(id text PRIMARY KEY,staff_id text REFERENCES legalflow.users(id),data jsonb NOT NULL);
CREATE TABLE legalflow.activities(id text PRIMARY KEY,case_id text NOT NULL REFERENCES legalflow.cases(id) ON DELETE CASCADE,user_id text REFERENCES legalflow.users(id),text text NOT NULL,kind text NOT NULL DEFAULT 'update',at timestamptz NOT NULL DEFAULT now());
CREATE INDEX activities_case ON legalflow.activities(case_id,at);
CREATE TABLE legalflow.comments(id text PRIMARY KEY,case_id text NOT NULL REFERENCES legalflow.cases(id) ON DELETE CASCADE,user_id text NOT NULL REFERENCES legalflow.users(id),text text NOT NULL,at timestamptz NOT NULL DEFAULT now());
CREATE TABLE legalflow.documents(id text PRIMARY KEY,case_id text REFERENCES legalflow.cases(id) ON DELETE RESTRICT,name text NOT NULL,mime text NOT NULL,bytes bigint NOT NULL,kind text NOT NULL,dropbox_path text NOT NULL UNIQUE,uploaded_by text NOT NULL REFERENCES legalflow.users(id),state text NOT NULL CHECK(state IN ('uploading','ready','deleting')),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX documents_case ON legalflow.documents(case_id);
CREATE TABLE legalflow.conversations(id text PRIMARY KEY,pair text UNIQUE,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE legalflow.conversation_members(conversation_id text NOT NULL REFERENCES legalflow.conversations(id) ON DELETE CASCADE,user_id text NOT NULL REFERENCES legalflow.users(id),last_read_id text,PRIMARY KEY(conversation_id,user_id));
CREATE INDEX members_user ON legalflow.conversation_members(user_id);
CREATE TABLE legalflow.messages(id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES legalflow.conversations(id) ON DELETE CASCADE,user_id text NOT NULL REFERENCES legalflow.users(id),text text NOT NULL,at timestamptz NOT NULL DEFAULT now());
CREATE INDEX messages_conversation ON legalflow.messages(conversation_id,at);
CREATE TABLE legalflow.notifications(id text PRIMARY KEY,user_id text NOT NULL REFERENCES legalflow.users(id) ON DELETE CASCADE,kind text NOT NULL,text text NOT NULL,link text,read boolean NOT NULL DEFAULT false,at timestamptz NOT NULL DEFAULT now());
CREATE INDEX notifications_user ON legalflow.notifications(user_id,at);
CREATE TABLE legalflow.preferences(user_id text PRIMARY KEY REFERENCES legalflow.users(id) ON DELETE CASCADE,data jsonb NOT NULL DEFAULT '{}');
CREATE TABLE legalflow.custom_fields(id text PRIMARY KEY,data jsonb NOT NULL);
CREATE TABLE legalflow.settings(key text PRIMARY KEY,value text NOT NULL);
CREATE TABLE legalflow.sessions(sid varchar PRIMARY KEY,sess json NOT NULL,expire timestamp(6) NOT NULL);
CREATE INDEX sessions_expire ON legalflow.sessions(expire);
CREATE TABLE legalflow.auth_attempts(key text PRIMARY KEY,count integer NOT NULL,reset_at timestamptz NOT NULL);
CREATE TABLE legalflow.audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id text,action text NOT NULL,record_id text,at timestamptz NOT NULL DEFAULT now());
