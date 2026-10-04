-- Content-free, expiring admission gates. They never represent sync success.
-- Keep an uncertain send reserved briefly; durable snapshots rediscover work
-- after expiry even if the producer or consumer was interrupted.
CREATE TABLE calendar_enqueue_gates (
  week_start TEXT PRIMARY KEY,
  regular_until INTEGER NOT NULL DEFAULT 0,
  manual_until INTEGER NOT NULL DEFAULT 0
);
