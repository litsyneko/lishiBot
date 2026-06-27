-- Supabase SQL migration: gambling stats + ranking RPC
-- Run this in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS gambling_stats (
  user_id TEXT PRIMARY KEY,
  total_bet BIGINT NOT NULL DEFAULT 0,
  total_won BIGINT NOT NULL DEFAULT 0,
  bet_count INTEGER NOT NULL DEFAULT 0,
  win_count INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE gambling_stats ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on gambling_stats" ON gambling_stats FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_gambling_stats_user_id
  ON gambling_stats(user_id);

CREATE OR REPLACE FUNCTION record_gamble(
  p_user_id TEXT,
  p_bet BIGINT,
  p_won BIGINT,
  p_win BOOLEAN
) RETURNS VOID
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO gambling_stats (user_id, total_bet, total_won, bet_count, win_count)
  VALUES (p_user_id, p_bet, p_won, 1, CASE WHEN p_win THEN 1 ELSE 0 END)
  ON CONFLICT (user_id) DO UPDATE SET
    total_bet = gambling_stats.total_bet + p_bet,
    total_won = gambling_stats.total_won + p_won,
    bet_count = gambling_stats.bet_count + 1,
    win_count = gambling_stats.win_count + CASE WHEN p_win THEN 1 ELSE 0 END;
END;
$$;

CREATE OR REPLACE FUNCTION get_gambling_ranking(
  p_limit INTEGER DEFAULT 10
) RETURNS TABLE (
  user_id TEXT,
  total_bet BIGINT,
  total_won BIGINT,
  net BIGINT,
  bet_count INTEGER,
  win_count INTEGER,
  win_rate NUMERIC
)
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.user_id,
    s.total_bet,
    s.total_won,
    (s.total_won - s.total_bet) AS net,
    s.bet_count,
    s.win_count,
    CASE WHEN s.bet_count > 0 THEN ROUND(s.win_count::NUMERIC / s.bet_count * 100, 1) ELSE 0 END AS win_rate
  FROM gambling_stats s
  ORDER BY net DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
END;
$$;
