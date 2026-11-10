-- v1.0 observability (NFR-OBS-01): a record of the alerts the system has raised, so the same trouble is reported once an hour
-- and not on every run of a scheduler that comes round every minute.

CREATE TABLE alert_log (
  key text NOT NULL,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  message text NOT NULL DEFAULT '',
  raised_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_log_key_idx ON alert_log (key, business_id, raised_at DESC);
ALTER TABLE alert_log ENABLE ROW LEVEL SECURITY;
