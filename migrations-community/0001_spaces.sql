PRAGMA defer_foreign_keys=ON;
CREATE TABLE community_members(sub TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,email_authoritative INTEGER NOT NULL DEFAULT 0,calendar_generation INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE community_sync_admissions(member_sub TEXT PRIMARY KEY REFERENCES community_members(sub) ON DELETE CASCADE,last_at INTEGER NOT NULL);
CREATE TABLE community_sessions(hash TEXT PRIMARY KEY,member_sub TEXT NOT NULL REFERENCES community_members(sub) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
CREATE INDEX community_sessions_expiry ON community_sessions(expires_at);
CREATE TABLE community_oauth_states(state_hash TEXT PRIMARY KEY,purpose TEXT NOT NULL CHECK(purpose IN ('login','calendar')),member_sub TEXT,session_hash TEXT,nonce TEXT NOT NULL,verifier TEXT NOT NULL,grant_generation INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL);
CREATE INDEX community_oauth_expiry ON community_oauth_states(expires_at);
CREATE TABLE community_spaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,location TEXT NOT NULL,owner_sub TEXT NOT NULL REFERENCES community_members(sub),revision INTEGER NOT NULL DEFAULT 1,sources_revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL);
CREATE TABLE community_memberships(space_id TEXT NOT NULL REFERENCES community_spaces(id) ON DELETE CASCADE,member_sub TEXT NOT NULL REFERENCES community_members(sub) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('owner','member')),share_enabled INTEGER NOT NULL DEFAULT 1 CHECK(share_enabled IN (0,1)),joined_at INTEGER NOT NULL,PRIMARY KEY(space_id,member_sub));
CREATE INDEX community_memberships_member ON community_memberships(member_sub,space_id);
CREATE TABLE community_invites(id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES community_spaces(id) ON DELETE CASCADE,email TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_by TEXT NOT NULL REFERENCES community_members(sub),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,accepted_sub TEXT,accepted_at INTEGER,revoked_at INTEGER);
CREATE INDEX community_invites_space ON community_invites(space_id,expires_at);
CREATE TABLE community_grants(member_sub TEXT PRIMARY KEY REFERENCES community_members(sub) ON DELETE CASCADE,refresh_cipher TEXT NOT NULL,version TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('connected','reauthorize')),scope TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE community_snapshots(space_id TEXT NOT NULL,member_sub TEXT NOT NULL,space_revision INTEGER NOT NULL,grant_version TEXT NOT NULL,range_start TEXT NOT NULL,range_end TEXT NOT NULL,data TEXT NOT NULL DEFAULT '[]',calendar_count INTEGER NOT NULL DEFAULT 0,synced_at INTEGER NOT NULL DEFAULT 0,error_code TEXT,PRIMARY KEY(space_id,member_sub),FOREIGN KEY(space_id,member_sub) REFERENCES community_memberships(space_id,member_sub) ON DELETE CASCADE);
CREATE TABLE community_sync_jobs(id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES community_spaces(id) ON DELETE CASCADE,requested_by TEXT NOT NULL REFERENCES community_members(sub),requested_at INTEGER NOT NULL,range_start TEXT NOT NULL,range_end TEXT NOT NULL,space_revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','complete','partial','error')),lease_id TEXT NOT NULL DEFAULT '',lease_until INTEGER NOT NULL DEFAULT 0,finished_at INTEGER NOT NULL DEFAULT 0,error_code TEXT);
CREATE UNIQUE INDEX community_active_job ON community_sync_jobs(space_id) WHERE status IN ('queued','running');
CREATE INDEX community_jobs_member_time ON community_sync_jobs(requested_by,requested_at);
CREATE TABLE community_sync_items(job_id TEXT NOT NULL REFERENCES community_sync_jobs(id) ON DELETE CASCADE,member_sub TEXT NOT NULL REFERENCES community_members(sub) ON DELETE CASCADE,grant_version TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN ('pending','running','success','error','skipped')),error_code TEXT,PRIMARY KEY(job_id,member_sub));

-- A source permission generation is independent of the location generation:
-- removal/revocation hides that source without discarding others' cached events.
CREATE TRIGGER community_membership_insert AFTER INSERT ON community_memberships BEGIN
  UPDATE community_spaces SET sources_revision=sources_revision+1 WHERE id=NEW.space_id;
END;
CREATE TRIGGER community_membership_delete AFTER DELETE ON community_memberships BEGIN
  UPDATE community_spaces SET sources_revision=sources_revision+1 WHERE id=OLD.space_id;
END;
CREATE TRIGGER community_membership_update AFTER UPDATE ON community_memberships BEGIN
  UPDATE community_spaces SET sources_revision=sources_revision+1 WHERE id IN (OLD.space_id,NEW.space_id);
END;
CREATE TRIGGER community_grant_insert AFTER INSERT ON community_grants BEGIN
  UPDATE community_spaces SET sources_revision=sources_revision+1 WHERE id IN (SELECT space_id FROM community_memberships WHERE member_sub=NEW.member_sub);
END;
CREATE TRIGGER community_grant_delete AFTER DELETE ON community_grants BEGIN
  UPDATE community_spaces SET sources_revision=sources_revision+1 WHERE id IN (SELECT space_id FROM community_memberships WHERE member_sub=OLD.member_sub);
END;
CREATE TRIGGER community_grant_update AFTER UPDATE ON community_grants BEGIN
  UPDATE community_spaces SET sources_revision=sources_revision+1 WHERE id IN (SELECT space_id FROM community_memberships WHERE member_sub IN (OLD.member_sub,NEW.member_sub));
END;
CREATE TRIGGER community_member_profile AFTER UPDATE OF email,name ON community_members WHEN OLD.email!=NEW.email OR OLD.name!=NEW.name BEGIN
  UPDATE community_spaces SET sources_revision=sources_revision+1 WHERE id IN (SELECT space_id FROM community_memberships WHERE member_sub=NEW.sub);
END;
