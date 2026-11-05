CREATE TABLE content_previews (
  source_cid TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'unsupported', 'failed')),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  descriptor TEXT NOT NULL,
  thumbnail_cid TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT NOT NULL,
  lease TEXT,
  lease_until TEXT,
  unreferenced_at TEXT,
  PRIMARY KEY (source_cid, version)
);
CREATE INDEX content_previews_work ON content_previews (status, retry_at);
CREATE INDEX content_previews_thumbnail ON content_previews (thumbnail_cid);
CREATE UNIQUE INDEX content_previews_active ON content_previews (source_cid) WHERE active = 1;
CREATE TABLE preview_images (
  cid TEXT PRIMARY KEY,
  bytes BLOB NOT NULL CHECK (length(bytes) <= 65536),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 480),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 480),
  unreferenced_at TEXT
);
CREATE INDEX content_previews_retention ON content_previews (unreferenced_at);
CREATE INDEX preview_images_retention ON preview_images (unreferenced_at);
