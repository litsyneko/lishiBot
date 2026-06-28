-- Supabase SQL migration: boost_celebration_settings
-- Run this in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS boost_celebration_settings (
  guild_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE boost_celebration_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on boost_celebration_settings" ON boost_celebration_settings FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_boost_celebration_settings_guild_id
  ON boost_celebration_settings(guild_id);
