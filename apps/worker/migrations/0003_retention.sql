CREATE TABLE storage_objects (
  object_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('writing', 'ready', 'deleting')),
  unreferenced_at TEXT NOT NULL,
  retry_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
INSERT INTO storage_objects (object_key, state, unreferenced_at, retry_at)
SELECT object_key, 'ready', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM car_dags;
CREATE INDEX storage_objects_retry ON storage_objects(state, retry_at, unreferenced_at);

ALTER TABLE car_blocks RENAME TO old_car_blocks;
ALTER TABLE car_dags RENAME TO old_car_dags;
CREATE TABLE car_dags (
  root TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE REFERENCES storage_objects(object_key),
  size INTEGER NOT NULL CHECK (size > 0)
);
INSERT INTO car_dags SELECT * FROM old_car_dags;
CREATE TABLE car_blocks (
  cid TEXT PRIMARY KEY,
  object_key TEXT NOT NULL REFERENCES storage_objects(object_key),
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0)
);
INSERT INTO car_blocks SELECT * FROM old_car_blocks;
DROP TABLE old_car_blocks;
DROP TABLE old_car_dags;
CREATE INDEX car_blocks_object ON car_blocks(object_key);

CREATE TABLE retained_blocks (
  cid TEXT PRIMARY KEY,
  unreferenced_at TEXT
);
INSERT INTO retained_blocks
SELECT cid, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM car_blocks
UNION
SELECT root, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM car_dags;
CREATE TABLE object_blocks (
  object_key TEXT NOT NULL REFERENCES storage_objects(object_key) ON DELETE CASCADE,
  cid TEXT NOT NULL,
  PRIMARY KEY (object_key, cid)
);
INSERT INTO object_blocks SELECT object_key, cid FROM car_blocks
UNION SELECT object_key, root FROM car_dags;
CREATE INDEX object_blocks_cid ON object_blocks(cid);

CREATE TABLE dag_roots (root TEXT PRIMARY KEY);
CREATE TABLE dag_members (
  root TEXT NOT NULL REFERENCES dag_roots(root) ON DELETE CASCADE,
  cid TEXT NOT NULL,
  PRIMARY KEY (root, cid)
);
CREATE INDEX dag_members_cid ON dag_members(cid, root);
CREATE INDEX pins_cid ON pins(cid);
CREATE TABLE retention_backfill (root TEXT PRIMARY KEY, attempted_at TEXT NOT NULL);
CREATE TABLE retention_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  scan_cursor TEXT,
  safe_after TEXT NOT NULL
);
INSERT INTO retention_state VALUES (1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days'));
CREATE TABLE retention_write_guard (id INTEGER PRIMARY KEY CHECK (id = 1));
CREATE INDEX agent_tokens_invalid ON agent_tokens(
  CASE WHEN revoked_at IS NULL OR expires_at < revoked_at THEN expires_at ELSE revoked_at END
);
