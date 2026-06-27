-- Supabase SQL migration: random drop stats + leaderboard
-- Run this in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS random_drop_stats (
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  total_claimed INTEGER NOT NULL DEFAULT 0,
  total_amount BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, guild_id)
);

ALTER TABLE random_drop_stats ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on random_drop_stats" ON random_drop_stats FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_random_drop_stats_guild
  ON random_drop_stats(guild_id);

CREATE OR REPLACE FUNCTION record_drop_claim(
  p_user_id TEXT,
  p_guild_id TEXT,
  p_amount BIGINT
) RETURNS VOID
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO random_drop_stats (user_id, guild_id, total_claimed, total_amount)
  VALUES (p_user_id, p_guild_id, 1, p_amount)
  ON CONFLICT (user_id, guild_id) DO UPDATE SET
    total_claimed = random_drop_stats.total_claimed + 1,
    total_amount = random_drop_stats.total_amount + p_amount;
END;
$$;

CREATE OR REPLACE FUNCTION get_drop_leaderboard(
  p_guild_id TEXT,
  p_limit INTEGER DEFAULT 10
) RETURNS TABLE (
  user_id TEXT,
  total_claimed INTEGER,
  total_amount BIGINT
)
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.user_id,
    s.total_claimed,
    s.total_amount
  FROM random_drop_stats s
  WHERE s.guild_id = p_guild_id
  ORDER BY s.total_amount DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
END;
$$;
