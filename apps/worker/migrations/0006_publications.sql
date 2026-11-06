CREATE TABLE deleted_pins (
  account_id TEXT NOT NULL,
  cid TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (account_id, cid),
  FOREIGN KEY (account_id, cid) REFERENCES pins(account_id, cid) ON DELETE CASCADE
);
CREATE INDEX deleted_pins_expiry ON deleted_pins(expires_at);

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  title TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  expires_at TEXT
);
CREATE INDEX publications_account ON publications(account_id, id);
CREATE INDEX publications_expiry ON publications(expires_at);
CREATE TABLE publication_revisions (
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  cid TEXT NOT NULL,
  size INTEGER NOT NULL,
  blocks INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (publication_id, revision)
);
CREATE TABLE publication_retention (
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  cid TEXT NOT NULL,
  PRIMARY KEY (publication_id, cid)
);
CREATE INDEX publication_retention_cid ON publication_retention(cid);
CREATE VIEW retained_roots AS SELECT cid FROM pins UNION SELECT cid FROM publication_retention;
CREATE TABLE publication_requests (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  request_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (account_id, request_id)
);
CREATE UNIQUE INDEX publication_requests_attempt ON publication_requests(attempt_id);
CREATE TABLE publication_operations (
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (publication_id, sequence)
);
