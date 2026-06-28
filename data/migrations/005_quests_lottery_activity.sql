-- Supabase SQL migration: daily quests, lottery, activity rewards, random drops
-- Run this in Supabase SQL Editor.

-- ============================================================
-- daily_quests: 일일 퀘스트 진행도
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_quests (
  user_id TEXT NOT NULL,
  quest_date TEXT NOT NULL,
  gamble_count INTEGER NOT NULL DEFAULT 0,
  rps_count INTEGER NOT NULL DEFAULT 0,
  claimed BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, quest_date)
);

ALTER TABLE daily_quests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on daily_quests" ON daily_quests FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- lottery_entries: 주간 복권 참여 기록
-- ============================================================
CREATE TABLE IF NOT EXISTS lottery_entries (
  user_id TEXT NOT NULL,
  week_key TEXT NOT NULL,
  claimed BOOLEAN NOT NULL DEFAULT false,
  prize BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, week_key)
);

ALTER TABLE lottery_entries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on lottery_entries" ON lottery_entries FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- random_drops: 선착 보상 설정 (길드별)
-- ============================================================
CREATE TABLE IF NOT EXISTS random_drops (
  guild_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  min_amount INTEGER NOT NULL DEFAULT 1000,
  max_amount INTEGER NOT NULL DEFAULT 50000,
  drops_per_day INTEGER NOT NULL DEFAULT 4,
  start_hour INTEGER NOT NULL DEFAULT 4,
  end_hour INTEGER NOT NULL DEFAULT 23,
  channel_id TEXT
);

-- 기존 random_drops 테이블에 channel_id, start_hour, admin_channel_id 컬럼이 없으면 추가
DO $$
BEGIN
  BEGIN
    ALTER TABLE random_drops ADD COLUMN IF NOT EXISTS channel_id TEXT;
  EXCEPTION WHEN OTHERS THEN NULL; END;

  BEGIN
    ALTER TABLE random_drops ADD COLUMN IF NOT EXISTS start_hour INTEGER NOT NULL DEFAULT 4;
  EXCEPTION WHEN OTHERS THEN NULL; END;

  BEGIN
    ALTER TABLE random_drops ADD COLUMN IF NOT EXISTS end_hour INTEGER NOT NULL DEFAULT 23;
  EXCEPTION WHEN OTHERS THEN NULL; END;

  BEGIN
    ALTER TABLE random_drops ADD COLUMN IF NOT EXISTS admin_channel_id TEXT;
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

ALTER TABLE random_drops ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on random_drops" ON random_drops FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- random_drop_claims: 선착 보상 수령 기록 (중복 방지)
-- ============================================================
CREATE TABLE IF NOT EXISTS random_drop_claims (
  drop_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  claimed_by TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE random_drop_claims ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on random_drop_claims" ON random_drop_claims FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- activity_tracking: 메시지 활동 보상 추적
-- ============================================================
CREATE TABLE IF NOT EXISTS activity_tracking (
  user_id TEXT NOT NULL,
  track_date TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  reward_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, track_date)
);

ALTER TABLE activity_tracking ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on activity_tracking" ON activity_tracking FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- RPC: record_quest_progress
-- ============================================================
CREATE OR REPLACE FUNCTION record_quest_progress(
  p_user_id TEXT,
  p_quest_date TEXT,
  p_quest_type TEXT
) RETURNS VOID
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO daily_quests (user_id, quest_date, gamble_count, rps_count, claimed)
  VALUES (p_user_id, p_quest_date, 0, 0, false)
  ON CONFLICT (user_id, quest_date) DO UPDATE SET
    gamble_count = CASE WHEN p_quest_type = 'gamble' THEN daily_quests.gamble_count + 1 ELSE daily_quests.gamble_count END,
    rps_count = CASE WHEN p_quest_type = 'rps' THEN daily_quests.rps_count + 1 ELSE daily_quests.rps_count END;
END;
$$;

-- ============================================================
-- RPC: claim_quest_reward
-- ============================================================
CREATE OR REPLACE FUNCTION claim_quest_reward(
  p_user_id TEXT,
  p_quest_date TEXT,
  p_gamble_required INTEGER,
  p_rps_required INTEGER,
  p_reward INTEGER
) RETURNS BOOLEAN
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
  quest_record RECORD;
BEGIN
  SELECT * INTO quest_record FROM daily_quests
  WHERE user_id = p_user_id AND quest_date = p_quest_date
  FOR UPDATE;

  IF quest_record.claimed = true THEN
    RETURN FALSE;
  END IF;

  IF quest_record.gamble_count >= p_gamble_required AND quest_record.rps_count >= p_rps_required THEN
    UPDATE daily_quests SET claimed = true
    WHERE user_id = p_user_id AND quest_date = p_quest_date;

    PERFORM add_balance(p_user_id, p_reward);
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;

-- ============================================================
-- RPC: claim_lottery
-- ============================================================
CREATE OR REPLACE FUNCTION claim_lottery(
  p_user_id TEXT,
  p_week_key TEXT,
  p_random DOUBLE PRECISION
) RETURNS BIGINT
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
  existing RECORD;
  prize BIGINT;
BEGIN
  SELECT * INTO existing FROM lottery_entries
  WHERE user_id = p_user_id AND week_key = p_week_key
  FOR UPDATE;

  IF existing.claimed = true THEN
    RETURN -1;
  END IF;

  IF p_random < 0.001 THEN
    prize := 1000000;
  ELSIF p_random < 0.01 THEN
    prize := 100000;
  ELSIF p_random < 0.10 THEN
    prize := 10000;
  ELSIF p_random < 0.40 THEN
    prize := 3000;
  ELSE
    prize := 0;
  END IF;

  INSERT INTO lottery_entries (user_id, week_key, claimed, prize)
  VALUES (p_user_id, p_week_key, true, prize)
  ON CONFLICT (user_id, week_key) DO UPDATE SET
    claimed = true,
    prize = lottery_entries.prize;

  IF prize > 0 THEN
    PERFORM add_balance(p_user_id, prize);
  END IF;

  RETURN prize;
END;
$$;

-- ============================================================
-- RPC: record_activity
-- ============================================================
CREATE OR REPLACE FUNCTION record_activity(
  p_user_id TEXT,
  p_track_date TEXT,
  p_reward_per INTEGER,
  p_max_rewards INTEGER
) RETURNS INTEGER
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
  track_record RECORD;
  new_reward_count INTEGER;
BEGIN
  SELECT * INTO track_record FROM activity_tracking
  WHERE user_id = p_user_id AND track_date = p_track_date
  FOR UPDATE;

  IF track_record IS NULL THEN
    INSERT INTO activity_tracking (user_id, track_date, message_count, reward_count)
    VALUES (p_user_id, p_track_date, 1, 0);
    RETURN 0;
  END IF;

  IF track_record.reward_count >= p_max_rewards THEN
    UPDATE activity_tracking SET message_count = activity_tracking.message_count + 1
    WHERE user_id = p_user_id AND track_date = p_track_date;
    RETURN 0;
  END IF;

  new_reward_count := track_record.reward_count + 1;
  UPDATE activity_tracking SET
    message_count = activity_tracking.message_count + 1,
    reward_count = new_reward_count
  WHERE user_id = p_user_id AND track_date = p_track_date;

  PERFORM add_balance(p_user_id, p_reward_per);
  RETURN p_reward_per;
END;
$$;
