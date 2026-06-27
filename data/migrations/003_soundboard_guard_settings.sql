-- Supabase SQL migration: soundboard_guard_settings
-- Run this in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS soundboard_guard_settings (
  guild_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE soundboard_guard_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on soundboard_guard_settings" ON soundboard_guard_settings FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_soundboard_guard_settings_guild_id
  ON soundboard_guard_settings(guild_id);
