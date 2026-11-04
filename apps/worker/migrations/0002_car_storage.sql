CREATE TABLE car_dags (
  root TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL CHECK (size > 0)
);

CREATE TABLE car_blocks (
  cid TEXT PRIMARY KEY,
  object_key TEXT NOT NULL REFERENCES car_dags(object_key),
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0)
);
CREATE INDEX car_blocks_object ON car_blocks(object_key);
