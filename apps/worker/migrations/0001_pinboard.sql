CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'google'),
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider, subject)
);

CREATE TABLE pins (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  cid TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  blocks INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, cid)
);
CREATE INDEX pins_account_created ON pins(account_id, created_at DESC, cid);

CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX agent_tokens_account ON agent_tokens(account_id, created_at DESC);
