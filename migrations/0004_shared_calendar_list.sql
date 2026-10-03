ALTER TABLE calendar_connections ADD COLUMN shared_calendars INTEGER NOT NULL DEFAULT 0 CHECK(shared_calendars IN (0,1));
ALTER TABLE calendar_snapshots ADD COLUMN calendar_count INTEGER NOT NULL DEFAULT 1;
