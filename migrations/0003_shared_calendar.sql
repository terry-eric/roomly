CREATE TABLE room_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  location TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1
);
INSERT INTO room_settings(id) VALUES(1);
CREATE TABLE calendar_oauth_states (
  hash TEXT PRIMARY KEY,
  member_sub TEXT NOT NULL REFERENCES members(sub) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE calendar_connections (
  member_sub TEXT PRIMARY KEY REFERENCES members(sub) ON DELETE CASCADE,
  refresh_cipher TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('connected','reauthorize')),
  updated_at INTEGER NOT NULL,
  error_code TEXT
);
CREATE TABLE calendar_snapshots (
  member_sub TEXT NOT NULL REFERENCES members(sub) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  room_revision INTEGER NOT NULL,
  connection_version TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '[]',
  synced_at INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT NOT NULL DEFAULT '',
  error_code TEXT,
  PRIMARY KEY(member_sub,week_start)
);
CREATE INDEX calendar_snapshots_retry ON calendar_snapshots(retry_at);
