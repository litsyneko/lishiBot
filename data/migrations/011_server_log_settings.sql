CREATE TABLE IF NOT EXISTS server_log_settings (
  guild_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  category_channels JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE server_log_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on server_log_settings" ON server_log_settings FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_server_log_settings_guild_id
  ON server_log_settings(guild_id);

CREATE OR REPLACE FUNCTION set_server_log_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_server_log_settings_updated_at ON server_log_settings;
CREATE TRIGGER trg_server_log_settings_updated_at
  BEFORE UPDATE ON server_log_settings
  FOR EACH ROW
  EXECUTE FUNCTION set_server_log_settings_updated_at();
