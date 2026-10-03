CREATE TABLE IF NOT EXISTS members (
  sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  requested_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT
);
CREATE INDEX IF NOT EXISTS members_status ON members(status, requested_at);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  member_sub TEXT NOT NULL REFERENCES members(sub),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS login_nonces (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS nonce_expiry ON login_nonces(expires_at);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  member_sub TEXT NOT NULL UNIQUE REFERENCES members(sub),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','sent')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  error_code TEXT
);
