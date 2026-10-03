ALTER TABLE calendar_connections ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0 CHECK(change_revision>=0);
ALTER TABLE calendar_snapshots ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0 CHECK(change_revision>=0);
ALTER TABLE calendar_snapshots ADD COLUMN attempt_revision INTEGER NOT NULL DEFAULT 0 CHECK(attempt_revision>=0);

-- Calendar identifiers are transient. Keys below are opaque hashes; channel
-- secrets are stored only as hashes and never returned to the browser.
CREATE TABLE calendar_watch_targets (
  member_sub TEXT NOT NULL REFERENCES members(sub) ON DELETE CASCADE,
  connection_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('events','list')),
  calendar_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(member_sub,connection_version,kind,calendar_key)
);
CREATE TABLE calendar_watch_channels (
  channel_id TEXT PRIMARY KEY,
  member_sub TEXT NOT NULL REFERENCES members(sub) ON DELETE CASCADE,
  connection_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('events','list')),
  calendar_key TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('pending','active')),
  created_at INTEGER NOT NULL
);
CREATE INDEX calendar_watch_channels_target ON calendar_watch_channels(member_sub,connection_version,kind,calendar_key,expires_at);
