CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  state TEXT,
  challenge TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX oauth_requests_expiry ON oauth_requests(expires_at);

CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY REFERENCES oauth_requests(id),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  code_hash TEXT UNIQUE,
  challenge TEXT NOT NULL,
  code_expires_at INTEGER NOT NULL,
  token_hash TEXT UNIQUE,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX oauth_grants_account ON oauth_grants(account_id, created_at DESC);
