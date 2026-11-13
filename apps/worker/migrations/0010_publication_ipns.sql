CREATE TABLE publication_ipns (
  publication_id TEXT PRIMARY KEY REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL CHECK(length(public_key) = 36),
  key_version INTEGER NOT NULL DEFAULT 1 CHECK(key_version = 1),
  encrypted_key BLOB NOT NULL CHECK(length(encrypted_key) > 16),
  nonce BLOB NOT NULL CHECK(length(nonce) = 12),
  record BLOB NOT NULL CHECK(length(record) > 0 AND length(record) <= 10240),
  record_cid TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 0 AND sequence <= 9007199254740991),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  expires_at INTEGER NOT NULL,
  retry_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX publication_ipns_renewal ON publication_ipns(retry_at, expires_at, publication_id);
