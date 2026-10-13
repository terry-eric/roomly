-- One shared administrator preference controls periodic Google fallback reads.
-- Push notifications and manual refresh keep their existing admission rules.
ALTER TABLE room_settings ADD COLUMN sync_interval INTEGER NOT NULL DEFAULT 600
  CHECK(sync_interval IN (600,900,1800,3600));

CREATE TRIGGER room_sync_interval_reschedule AFTER UPDATE OF sync_interval ON room_settings
WHEN OLD.sync_interval IS NOT NEW.sync_interval
BEGIN
  -- retry_at also represents the last failed attempt plus its delay. Preserve
  -- that attempt time, including the manual cooldown, when changing the delay.
  UPDATE calendar_snapshots SET retry_at=MAX(0,retry_at-OLD.sync_interval+NEW.sync_interval)
    WHERE retry_at>0;
  UPDATE room_settings SET feed_revision=feed_revision+1 WHERE id=1;
END;

CREATE INDEX calendar_snapshots_attempt ON calendar_snapshots(member_sub,attempt_revision);
CREATE INDEX calendar_snapshots_active_lease ON calendar_snapshots(lease_until) WHERE lease_until>0;
