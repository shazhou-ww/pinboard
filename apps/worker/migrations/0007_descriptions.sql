CREATE TABLE node_descriptions (
  account_id TEXT NOT NULL,
  root_cid TEXT NOT NULL,
  node_cid TEXT NOT NULL,
  text TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  PRIMARY KEY (account_id, root_cid, node_cid),
  FOREIGN KEY (account_id, root_cid) REFERENCES pins(account_id, cid) ON DELETE CASCADE
);
ALTER TABLE publication_revisions ADD COLUMN descriptions TEXT NOT NULL DEFAULT '{}';
