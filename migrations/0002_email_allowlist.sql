CREATE TABLE IF NOT EXISTS email_allowlist (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  status TEXT NOT NULL CHECK (status IN ('approved','revoked')),
  member_sub TEXT REFERENCES members(sub),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES members(sub)
);
CREATE INDEX IF NOT EXISTS allowlist_member ON email_allowlist(member_sub);
