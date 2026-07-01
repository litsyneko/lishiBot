CREATE TABLE IF NOT EXISTS guild_text_levels (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  xp BIGINT NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  message_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS guild_voice_levels (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  xp BIGINT NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  total_seconds BIGINT NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS guild_voice_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  duration_seconds BIGINT NOT NULL DEFAULT 0,
  xp_awarded BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE guild_text_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_voice_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_voice_sessions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Allow all on guild_text_levels" ON guild_text_levels FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow all on guild_voice_levels" ON guild_voice_levels FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Allow all on guild_voice_sessions" ON guild_voice_sessions FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_guild_text_levels_ranking
  ON guild_text_levels(guild_id, xp DESC, message_count DESC);

CREATE INDEX IF NOT EXISTS idx_guild_voice_levels_ranking
  ON guild_voice_levels(guild_id, xp DESC, total_seconds DESC);

CREATE INDEX IF NOT EXISTS idx_guild_voice_sessions_user
  ON guild_voice_sessions(guild_id, user_id, started_at DESC);

CREATE OR REPLACE FUNCTION guild_activity_level_for_xp(p_xp BIGINT)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_level INTEGER := 1;
BEGIN
  WHILE p_xp >= (v_level * v_level * 300) LOOP
    v_level := v_level + 1;
  END LOOP;
  RETURN v_level;
END;
$$;

CREATE OR REPLACE FUNCTION set_guild_level_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guild_text_levels_updated_at ON guild_text_levels;
CREATE TRIGGER trg_guild_text_levels_updated_at
  BEFORE UPDATE ON guild_text_levels
  FOR EACH ROW
  EXECUTE FUNCTION set_guild_level_updated_at();

DROP TRIGGER IF EXISTS trg_guild_voice_levels_updated_at ON guild_voice_levels;
CREATE TRIGGER trg_guild_voice_levels_updated_at
  BEFORE UPDATE ON guild_voice_levels
  FOR EACH ROW
  EXECUTE FUNCTION set_guild_level_updated_at();

CREATE OR REPLACE FUNCTION record_guild_text_xp(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_xp BIGINT
) RETURNS TABLE (
  level INTEGER,
  xp BIGINT,
  message_count INTEGER,
  leveled_up BOOLEAN
)
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
  before_level INTEGER;
  after_record RECORD;
BEGIN
  SELECT guild_text_levels.level INTO before_level
  FROM guild_text_levels
  WHERE guild_id = p_guild_id AND user_id = p_user_id
  FOR UPDATE;

  INSERT INTO guild_text_levels (guild_id, user_id, xp, level, message_count)
  VALUES (p_guild_id, p_user_id, GREATEST(p_xp, 0), guild_activity_level_for_xp(GREATEST(p_xp, 0)), 1)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    xp = guild_text_levels.xp + GREATEST(p_xp, 0),
    level = guild_activity_level_for_xp(guild_text_levels.xp + GREATEST(p_xp, 0)),
    message_count = guild_text_levels.message_count + 1
  RETURNING guild_text_levels.level, guild_text_levels.xp, guild_text_levels.message_count
  INTO after_record;

  RETURN QUERY SELECT
    after_record.level,
    after_record.xp,
    after_record.message_count,
    COALESCE(before_level, 1) < after_record.level;
END;
$$;

CREATE OR REPLACE FUNCTION record_guild_voice_xp(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_channel_id TEXT,
  p_started_at TIMESTAMPTZ,
  p_ended_at TIMESTAMPTZ,
  p_duration_seconds BIGINT,
  p_xp BIGINT
) RETURNS TABLE (
  level INTEGER,
  xp BIGINT,
  total_seconds BIGINT,
  session_count INTEGER,
  leveled_up BOOLEAN
)
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
  before_level INTEGER;
  after_record RECORD;
  safe_duration BIGINT := GREATEST(p_duration_seconds, 0);
  safe_xp BIGINT := GREATEST(p_xp, 0);
BEGIN
  INSERT INTO guild_voice_sessions (
    guild_id,
    user_id,
    channel_id,
    started_at,
    ended_at,
    duration_seconds,
    xp_awarded
  ) VALUES (
    p_guild_id,
    p_user_id,
    p_channel_id,
    p_started_at,
    p_ended_at,
    safe_duration,
    safe_xp
  );

  SELECT guild_voice_levels.level INTO before_level
  FROM guild_voice_levels
  WHERE guild_id = p_guild_id AND user_id = p_user_id
  FOR UPDATE;

  INSERT INTO guild_voice_levels (guild_id, user_id, xp, level, total_seconds, session_count)
  VALUES (p_guild_id, p_user_id, safe_xp, guild_activity_level_for_xp(safe_xp), safe_duration, 1)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    xp = guild_voice_levels.xp + safe_xp,
    level = guild_activity_level_for_xp(guild_voice_levels.xp + safe_xp),
    total_seconds = guild_voice_levels.total_seconds + safe_duration,
    session_count = guild_voice_levels.session_count + 1
  RETURNING guild_voice_levels.level, guild_voice_levels.xp, guild_voice_levels.total_seconds, guild_voice_levels.session_count
  INTO after_record;

  RETURN QUERY SELECT
    after_record.level,
    after_record.xp,
    after_record.total_seconds,
    after_record.session_count,
    COALESCE(before_level, 1) < after_record.level;
END;
$$;
