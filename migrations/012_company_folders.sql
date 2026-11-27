CREATE TABLE legalflow.company_folders (
 id text PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX company_folders_unique_name ON legalflow.company_folders(lower(name));
ALTER TABLE legalflow.documents ADD COLUMN company_folder_id text REFERENCES legalflow.company_folders(id) ON DELETE RESTRICT;
ALTER TABLE legalflow.documents ADD CONSTRAINT documents_company_folder_scope CHECK(company_folder_id IS NULL OR case_id IS NULL);
CREATE INDEX documents_company_folder ON legalflow.documents(company_folder_id,created_at,id) WHERE case_id IS NULL;
