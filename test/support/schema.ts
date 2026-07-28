export const testSchemaSql = `
DROP TABLE IF EXISTS test_webhook_events;
DROP TABLE IF EXISTS test_fixture_config;
DROP TABLE IF EXISTS alert_deliveries;
DROP TABLE IF EXISTS alert_channels;
DROP TABLE IF EXISTS incidents;
DROP TABLE IF EXISTS monitors;

CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  expected_status INTEGER NOT NULL DEFAULT 200,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  interval_seconds INTEGER NOT NULL DEFAULT 60,
  failure_threshold INTEGER NOT NULL DEFAULT 2,
  success_threshold INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  allow_http INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown',
  failure_streak INTEGER NOT NULL DEFAULT 0,
  success_streak INTEGER NOT NULL DEFAULT 0,
  last_check_id TEXT,
  next_check_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX monitors_due
  ON monitors (enabled, deleted_at, next_check_at);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id),
  opening_check_id TEXT NOT NULL,
  closing_check_id TEXT,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT,
  cause TEXT NOT NULL,
  last_http_status INTEGER
);
CREATE UNIQUE INDEX incidents_one_open
  ON incidents (monitor_id) WHERE resolved_at IS NULL;

CREATE TABLE alert_channels (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id),
  kind TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE alert_deliveries (
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  event_kind TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES alert_channels(id),
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (incident_id, event_kind, channel_id)
);
CREATE INDEX alert_deliveries_claimable
  ON alert_deliveries (state, lease_until)
  WHERE state IN ('pending', 'delivering');

CREATE TABLE test_fixture_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  target_delay_ms INTEGER NOT NULL,
  target_status INTEGER NOT NULL,
  webhook_delay_ms INTEGER NOT NULL
);
INSERT INTO test_fixture_config
  (id, target_delay_ms, target_status, webhook_delay_ms)
VALUES (1, 0, 200, 0);

CREATE TABLE test_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
`;
