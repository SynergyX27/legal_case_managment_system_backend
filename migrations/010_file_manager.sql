CREATE TABLE legalflow.file_collections (
 id text PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 section text NOT NULL CHECK(section IN ('docs','visuals')),
 code text UNIQUE,
 position integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO legalflow.file_collections(id,name,section,code,position) VALUES
 ('general-docs','Other documents','docs',NULL,99),
 ('writ','Writ','docs',NULL,1),('application','Application','docs',NULL,2),
 ('summons','Summons','docs',NULL,3),('dispossession','Dispossession','docs',NULL,4),
 ('tenant-ledger','Tenant Ledger','docs',NULL,5),
 ('crew-pics','Crew Pics','visuals',NULL,1),('setout-pics','Setout Pics','visuals',NULL,2),
 ('vis-to','VIS - TO','visuals','VIS - TO',3),('vis-lo','VIS - LO','visuals','VIS - LO',4),
 ('vis-ri','VIS - RI','visuals','VIS - RI',5),('other-visuals','Other visuals','visuals',NULL,99);
ALTER TABLE legalflow.documents ADD COLUMN collection_id text REFERENCES legalflow.file_collections(id) ON DELETE RESTRICT;
ALTER TABLE legalflow.documents ADD COLUMN approval text NOT NULL DEFAULT 'approved' CHECK(approval IN ('pending','approved','rejected'));
ALTER TABLE legalflow.documents ADD COLUMN reviewed_by text REFERENCES legalflow.users(id);
ALTER TABLE legalflow.documents ADD COLUMN reviewed_at timestamptz;
ALTER TABLE legalflow.documents ADD COLUMN upload_hash text;
ALTER TABLE legalflow.documents ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE legalflow.documents SET collection_id=CASE WHEN kind IN ('image','video') THEN 'other-visuals' ELSE 'general-docs' END WHERE case_id IS NOT NULL;
CREATE INDEX documents_collection ON legalflow.documents(case_id,collection_id,approval,state,created_at,id);
CREATE INDEX cases_team_members ON legalflow.cases USING gin ((data->'teamMemberIds'));
