-- Revisions are transaction-local cache identities, never authorization.
-- Every reader must still check the live session and membership first.
ALTER TABLE room_settings ADD COLUMN sources_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_settings ADD COLUMN feed_revision INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER approved_member_insert_sources_revision AFTER INSERT ON members
WHEN NEW.status='approved'
BEGIN UPDATE room_settings SET sources_revision=sources_revision+1 WHERE id=1; END;

CREATE TRIGGER approved_member_delete_sources_revision AFTER DELETE ON members
WHEN OLD.status='approved'
BEGIN UPDATE room_settings SET sources_revision=sources_revision+1 WHERE id=1; END;

CREATE TRIGGER approved_member_update_sources_revision AFTER UPDATE OF sub,email,status ON members
WHEN (OLD.status='approved' OR NEW.status='approved')
 AND (OLD.sub IS NOT NEW.sub OR OLD.email IS NOT NEW.email OR OLD.status IS NOT NEW.status)
BEGIN UPDATE room_settings SET sources_revision=sources_revision+1 WHERE id=1; END;

CREATE TRIGGER room_sources_calendar_feed_revision AFTER UPDATE OF sources_revision,calendar_revision ON room_settings
WHEN OLD.sources_revision IS NOT NEW.sources_revision OR OLD.calendar_revision IS NOT NEW.calendar_revision
BEGIN UPDATE room_settings SET feed_revision=feed_revision+1 WHERE id=1; END;

-- First completion already changes calendar_revision in migration 0006.
-- Later unchanged successful refreshes must also invalidate cached timestamps.
CREATE TRIGGER completed_snapshot_time_feed_revision AFTER UPDATE OF synced_at ON calendar_snapshots
WHEN OLD.synced_at>0 AND OLD.synced_at IS NOT NEW.synced_at
BEGIN UPDATE room_settings SET feed_revision=feed_revision+1 WHERE id=1; END;
