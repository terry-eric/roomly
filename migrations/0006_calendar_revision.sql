-- A cheap, content-free revision for open boards. A push notification alone
-- does not change this value: readers must see the new committed cache first.
ALTER TABLE room_settings ADD COLUMN calendar_revision INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER calendar_connection_insert_revision AFTER INSERT ON calendar_connections
BEGIN UPDATE room_settings SET calendar_revision=calendar_revision+1 WHERE id=1; END;

CREATE TRIGGER calendar_connection_delete_revision AFTER DELETE ON calendar_connections
BEGIN UPDATE room_settings SET calendar_revision=calendar_revision+1 WHERE id=1; END;

CREATE TRIGGER calendar_connection_update_revision AFTER UPDATE OF status,version,shared_calendars ON calendar_connections
WHEN OLD.status IS NOT NEW.status OR OLD.version IS NOT NEW.version OR OLD.shared_calendars IS NOT NEW.shared_calendars
BEGIN UPDATE room_settings SET calendar_revision=calendar_revision+1 WHERE id=1; END;

CREATE TRIGGER calendar_snapshot_insert_revision AFTER INSERT ON calendar_snapshots
WHEN NEW.data!='[]' OR NEW.synced_at>0 OR NEW.error_code IS NOT NULL
BEGIN UPDATE room_settings SET calendar_revision=calendar_revision+1 WHERE id=1; END;

CREATE TRIGGER calendar_snapshot_update_revision AFTER UPDATE OF data,room_revision,connection_version,calendar_count,error_code,synced_at ON calendar_snapshots
WHEN OLD.data IS NOT NEW.data OR OLD.room_revision IS NOT NEW.room_revision
 OR OLD.connection_version IS NOT NEW.connection_version OR OLD.calendar_count IS NOT NEW.calendar_count
 OR OLD.error_code IS NOT NEW.error_code OR (OLD.synced_at=0 AND NEW.synced_at>0)
BEGIN UPDATE room_settings SET calendar_revision=calendar_revision+1 WHERE id=1; END;

CREATE TRIGGER calendar_snapshot_delete_revision AFTER DELETE ON calendar_snapshots
WHEN OLD.data!='[]' OR OLD.synced_at>0 OR OLD.error_code IS NOT NULL
BEGIN UPDATE room_settings SET calendar_revision=calendar_revision+1 WHERE id=1; END;

CREATE TRIGGER calendar_room_update_revision AFTER UPDATE OF revision ON room_settings
WHEN OLD.revision IS NOT NEW.revision
BEGIN UPDATE room_settings SET calendar_revision=calendar_revision+1 WHERE id=1; END;
