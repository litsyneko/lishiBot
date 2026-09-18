-- Supabase SQL migration: 경제 시스템을 서버(길드) 전용으로 전환
-- Run this in Supabase SQL Editor.
--
-- 기존에는 잔액/은행/출석/도박통계/퀘스트/복권/활동보상이 모두 user_id 기준
-- 전역 공유였다. 이 마이그레이션으로 전부 (guild_id, user_id) 기준 서버 전용으로
-- 바꾼다. 기존 전역 데이터는 메인 서버로 이관하여 잔액이 사라지지 않게 한다.
--
-- 이관 대상 메인 길드 ID: '1440598081648328816' (아래 SQL에서 리터럴로 직접 사용)

-- ============================================================
-- 0) accounts 를 참조하던 FK 제거 (accounts PK가 (guild_id,user_id)로 바뀌므로
--    user_id 단일 컬럼 참조 FK는 더 이상 성립하지 않는다. 무결성은 RPC 계층에서 보장)
-- ============================================================
ALTER TABLE gambling_stats     DROP CONSTRAINT IF EXISTS fk_gambling_stats_user;
ALTER TABLE daily_quests       DROP CONSTRAINT IF EXISTS fk_daily_quests_user;
ALTER TABLE lottery_entries    DROP CONSTRAINT IF EXISTS fk_lottery_entries_user;
ALTER TABLE activity_tracking  DROP CONSTRAINT IF EXISTS fk_activity_tracking_user;
ALTER TABLE random_drop_stats  DROP CONSTRAINT IF EXISTS fk_random_drop_stats_user;

-- ============================================================
-- 1) accounts -> (guild_id, user_id)
-- ============================================================
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS guild_id TEXT;
UPDATE accounts SET guild_id = '1440598081648328816' WHERE guild_id IS NULL;
ALTER TABLE accounts ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_pkey;
ALTER TABLE accounts ADD PRIMARY KEY (guild_id, user_id);

-- ============================================================
-- 2) gambling_stats -> (guild_id, user_id)
-- ============================================================
ALTER TABLE gambling_stats ADD COLUMN IF NOT EXISTS guild_id TEXT;
UPDATE gambling_stats SET guild_id = '1440598081648328816' WHERE guild_id IS NULL;
ALTER TABLE gambling_stats ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE gambling_stats DROP CONSTRAINT IF EXISTS gambling_stats_pkey;
ALTER TABLE gambling_stats ADD PRIMARY KEY (guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_gambling_stats_guild ON gambling_stats(guild_id);

-- ============================================================
-- 3) daily_quests -> (guild_id, user_id, quest_date)
-- ============================================================
ALTER TABLE daily_quests ADD COLUMN IF NOT EXISTS guild_id TEXT;
UPDATE daily_quests SET guild_id = '1440598081648328816' WHERE guild_id IS NULL;
ALTER TABLE daily_quests ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE daily_quests DROP CONSTRAINT IF EXISTS daily_quests_pkey;
ALTER TABLE daily_quests ADD PRIMARY KEY (guild_id, user_id, quest_date);

-- ============================================================
-- 4) lottery_entries -> (guild_id, user_id, week_key)
-- ============================================================
ALTER TABLE lottery_entries ADD COLUMN IF NOT EXISTS guild_id TEXT;
UPDATE lottery_entries SET guild_id = '1440598081648328816' WHERE guild_id IS NULL;
ALTER TABLE lottery_entries ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE lottery_entries DROP CONSTRAINT IF EXISTS lottery_entries_pkey;
ALTER TABLE lottery_entries ADD PRIMARY KEY (guild_id, user_id, week_key);

-- ============================================================
-- 5) activity_tracking -> (guild_id, user_id, track_date)
-- ============================================================
ALTER TABLE activity_tracking ADD COLUMN IF NOT EXISTS guild_id TEXT;
UPDATE activity_tracking SET guild_id = '1440598081648328816' WHERE guild_id IS NULL;
ALTER TABLE activity_tracking ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE activity_tracking DROP CONSTRAINT IF EXISTS activity_tracking_pkey;
ALTER TABLE activity_tracking ADD PRIMARY KEY (guild_id, user_id, track_date);

-- ============================================================
-- 6) RPC 재작성 (모두 p_guild_id 추가). 기존 전역 시그니처는 제거.
-- ============================================================

-- 구버전 함수 제거 (오버로드 충돌 방지)
DROP FUNCTION IF EXISTS add_balance(text, integer);
DROP FUNCTION IF EXISTS transfer_balance(text, text, integer);
DROP FUNCTION IF EXISTS admin_subtract_balance(text, integer);
DROP FUNCTION IF EXISTS claim_attendance(text, text, integer);
DROP FUNCTION IF EXISTS claim_attendance(text, text, integer, integer, integer);
DROP FUNCTION IF EXISTS record_gamble(text, bigint, bigint, boolean);
DROP FUNCTION IF EXISTS get_gambling_ranking(integer);
DROP FUNCTION IF EXISTS record_quest_progress(text, text, text);
DROP FUNCTION IF EXISTS claim_quest_reward(text, text, integer, integer, integer);
DROP FUNCTION IF EXISTS claim_lottery(text, text, double precision);
DROP FUNCTION IF EXISTS record_activity(text, text, integer, integer);
DROP FUNCTION IF EXISTS bank_deposit(text, bigint);
DROP FUNCTION IF EXISTS bank_withdraw(text, bigint);
DROP FUNCTION IF EXISTS claim_interest(text, text);

-- add_balance(p_guild_id, p_user_id, p_amount)
CREATE OR REPLACE FUNCTION add_balance(p_guild_id TEXT, p_user_id TEXT, p_amount INTEGER)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE new_balance BIGINT;
BEGIN
  INSERT INTO accounts (guild_id, user_id, balance)
  VALUES (p_guild_id, p_user_id, p_amount)
  ON CONFLICT (guild_id, user_id) DO UPDATE
    SET balance = accounts.balance + p_amount
  RETURNING balance INTO new_balance;
  RETURN new_balance;
END;
$$;

-- transfer_balance(p_guild_id, p_from, p_to, p_amount)
CREATE OR REPLACE FUNCTION transfer_balance(
  p_guild_id TEXT, p_from_user_id TEXT, p_to_user_id TEXT, p_amount INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE sender_balance BIGINT;
BEGIN
  SELECT balance INTO sender_balance FROM accounts
  WHERE guild_id = p_guild_id AND user_id = p_from_user_id FOR UPDATE;
  IF sender_balance IS NULL THEN sender_balance := 0; END IF;
  IF sender_balance < p_amount THEN RETURN FALSE; END IF;

  INSERT INTO accounts (guild_id, user_id, balance)
  VALUES (p_guild_id, p_from_user_id, -p_amount)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET balance = accounts.balance - p_amount;

  INSERT INTO accounts (guild_id, user_id, balance)
  VALUES (p_guild_id, p_to_user_id, p_amount)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET balance = accounts.balance + p_amount;
  RETURN TRUE;
END;
$$;

-- admin_subtract_balance(p_guild_id, p_user_id, p_amount) -> (subtracted, new_balance)
CREATE OR REPLACE FUNCTION admin_subtract_balance(
  p_guild_id TEXT, p_user_id TEXT, p_amount INTEGER
) RETURNS TABLE (subtracted BIGINT, new_balance BIGINT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_old BIGINT; v_new BIGINT;
BEGIN
  INSERT INTO accounts (guild_id, user_id, balance)
  VALUES (p_guild_id, p_user_id, 0)
  ON CONFLICT (guild_id, user_id) DO NOTHING;

  SELECT accounts.balance INTO v_old FROM accounts
  WHERE accounts.guild_id = p_guild_id AND accounts.user_id = p_user_id FOR UPDATE;

  v_new := GREATEST(0, v_old - p_amount);
  UPDATE accounts SET balance = v_new
  WHERE accounts.guild_id = p_guild_id AND accounts.user_id = p_user_id;

  RETURN QUERY SELECT v_old - v_new, v_new;
END;
$$;

-- claim_attendance(p_guild_id, p_user_id, p_today, p_reward, p_streak_bonus_7, p_streak_bonus_30) -> total reward (-1 이미 수령)
CREATE OR REPLACE FUNCTION claim_attendance(
  p_guild_id TEXT, p_user_id TEXT, p_today TEXT, p_reward INTEGER,
  p_streak_bonus_7 INTEGER DEFAULT 10000, p_streak_bonus_30 INTEGER DEFAULT 50000
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  acct RECORD; yesterday TEXT; new_streak INTEGER; total_reward INTEGER;
BEGIN
  INSERT INTO accounts (guild_id, user_id, balance)
  VALUES (p_guild_id, p_user_id, 0)
  ON CONFLICT (guild_id, user_id) DO NOTHING;

  SELECT balance, attendance_streak, last_attendance_date INTO acct
  FROM accounts WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;

  IF acct.last_attendance_date = p_today THEN RETURN -1; END IF;

  yesterday := to_char((p_today::date) - INTERVAL '1 day', 'YYYY-MM-DD');
  IF acct.last_attendance_date = yesterday THEN
    new_streak := COALESCE(acct.attendance_streak, 0) + 1;
  ELSE
    new_streak := 1;
  END IF;

  total_reward := p_reward;
  IF new_streak = 30 OR MOD(new_streak, 30) = 0 THEN
    total_reward := total_reward + p_streak_bonus_30;
  ELSIF MOD(new_streak, 7) = 0 THEN
    total_reward := total_reward + p_streak_bonus_7;
  END IF;

  UPDATE accounts
  SET balance = balance + total_reward,
      attendance_streak = new_streak,
      last_attendance_date = p_today,
      attendance_date = p_today
  WHERE guild_id = p_guild_id AND user_id = p_user_id;

  RETURN total_reward;
END;
$$;

-- record_gamble(p_guild_id, p_user_id, p_bet, p_won, p_win)
CREATE OR REPLACE FUNCTION record_gamble(
  p_guild_id TEXT, p_user_id TEXT, p_bet BIGINT, p_won BIGINT, p_win BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO gambling_stats (guild_id, user_id, total_bet, total_won, bet_count, win_count)
  VALUES (p_guild_id, p_user_id, p_bet, p_won, 1, CASE WHEN p_win THEN 1 ELSE 0 END)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    total_bet = gambling_stats.total_bet + p_bet,
    total_won = gambling_stats.total_won + p_won,
    bet_count = gambling_stats.bet_count + 1,
    win_count = gambling_stats.win_count + CASE WHEN p_win THEN 1 ELSE 0 END;
END;
$$;

-- get_gambling_ranking(p_guild_id, p_limit)
CREATE OR REPLACE FUNCTION get_gambling_ranking(p_guild_id TEXT, p_limit INTEGER DEFAULT 10)
RETURNS TABLE (
  user_id TEXT, total_bet BIGINT, total_won BIGINT, net BIGINT,
  bet_count INTEGER, win_count INTEGER, win_rate NUMERIC
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT s.user_id, s.total_bet, s.total_won, (s.total_won - s.total_bet) AS net,
         s.bet_count, s.win_count,
         CASE WHEN s.bet_count > 0 THEN ROUND(s.win_count::NUMERIC / s.bet_count * 100, 1) ELSE 0 END AS win_rate
  FROM gambling_stats s
  WHERE s.guild_id = p_guild_id
  ORDER BY net DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
END;
$$;

-- record_quest_progress(p_guild_id, p_user_id, p_quest_date, p_quest_type)
CREATE OR REPLACE FUNCTION record_quest_progress(
  p_guild_id TEXT, p_user_id TEXT, p_quest_date TEXT, p_quest_type TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO daily_quests (guild_id, user_id, quest_date, gamble_count, rps_count, claimed)
  VALUES (p_guild_id, p_user_id, p_quest_date, 0, 0, false)
  ON CONFLICT (guild_id, user_id, quest_date) DO UPDATE SET
    gamble_count = CASE WHEN p_quest_type = 'gamble' THEN daily_quests.gamble_count + 1 ELSE daily_quests.gamble_count END,
    rps_count    = CASE WHEN p_quest_type = 'rps'    THEN daily_quests.rps_count + 1    ELSE daily_quests.rps_count END;
END;
$$;

-- claim_quest_reward(p_guild_id, p_user_id, p_quest_date, p_gamble_required, p_rps_required, p_reward)
CREATE OR REPLACE FUNCTION claim_quest_reward(
  p_guild_id TEXT, p_user_id TEXT, p_quest_date TEXT,
  p_gamble_required INTEGER, p_rps_required INTEGER, p_reward INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE quest_record RECORD;
BEGIN
  SELECT * INTO quest_record FROM daily_quests
  WHERE guild_id = p_guild_id AND user_id = p_user_id AND quest_date = p_quest_date FOR UPDATE;

  IF quest_record.claimed = true THEN RETURN FALSE; END IF;

  IF quest_record.gamble_count >= p_gamble_required AND quest_record.rps_count >= p_rps_required THEN
    UPDATE daily_quests SET claimed = true
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND quest_date = p_quest_date;
    PERFORM add_balance(p_guild_id, p_user_id, p_reward);
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END;
$$;

-- claim_lottery(p_guild_id, p_user_id, p_week_key, p_random)
CREATE OR REPLACE FUNCTION claim_lottery(
  p_guild_id TEXT, p_user_id TEXT, p_week_key TEXT, p_random DOUBLE PRECISION
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE existing RECORD; prize BIGINT;
BEGIN
  SELECT * INTO existing FROM lottery_entries
  WHERE guild_id = p_guild_id AND user_id = p_user_id AND week_key = p_week_key FOR UPDATE;

  IF existing.claimed = true THEN RETURN -1; END IF;

  IF    p_random < 0.001 THEN prize := 1000000;
  ELSIF p_random < 0.01  THEN prize := 100000;
  ELSIF p_random < 0.10  THEN prize := 10000;
  ELSIF p_random < 0.40  THEN prize := 3000;
  ELSE  prize := 0;
  END IF;

  INSERT INTO lottery_entries (guild_id, user_id, week_key, claimed, prize)
  VALUES (p_guild_id, p_user_id, p_week_key, true, prize)
  ON CONFLICT (guild_id, user_id, week_key) DO UPDATE SET claimed = true, prize = lottery_entries.prize;

  IF prize > 0 THEN PERFORM add_balance(p_guild_id, p_user_id, prize); END IF;
  RETURN prize;
END;
$$;

-- record_activity(p_guild_id, p_user_id, p_track_date, p_reward_per, p_max_rewards)
CREATE OR REPLACE FUNCTION record_activity(
  p_guild_id TEXT, p_user_id TEXT, p_track_date TEXT, p_reward_per INTEGER, p_max_rewards INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE track_record RECORD; new_reward_count INTEGER;
BEGIN
  INSERT INTO accounts (guild_id, user_id, balance)
  VALUES (p_guild_id, p_user_id, 0)
  ON CONFLICT (guild_id, user_id) DO NOTHING;

  SELECT * INTO track_record FROM activity_tracking
  WHERE guild_id = p_guild_id AND user_id = p_user_id AND track_date = p_track_date FOR UPDATE;

  IF track_record IS NULL THEN
    INSERT INTO activity_tracking (guild_id, user_id, track_date, message_count, reward_count)
    VALUES (p_guild_id, p_user_id, p_track_date, 1, 0);
    RETURN 0;
  END IF;

  IF track_record.reward_count >= p_max_rewards THEN
    UPDATE activity_tracking SET message_count = activity_tracking.message_count + 1
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND track_date = p_track_date;
    RETURN 0;
  END IF;

  new_reward_count := track_record.reward_count + 1;
  UPDATE activity_tracking SET
    message_count = activity_tracking.message_count + 1,
    reward_count = new_reward_count
  WHERE guild_id = p_guild_id AND user_id = p_user_id AND track_date = p_track_date;

  PERFORM add_balance(p_guild_id, p_user_id, p_reward_per);
  RETURN p_reward_per;
END;
$$;

-- bank_deposit(p_guild_id, p_user_id, p_amount)
CREATE OR REPLACE FUNCTION bank_deposit(p_guild_id TEXT, p_user_id TEXT, p_amount BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE acct RECORD;
BEGIN
  IF p_amount <= 0 THEN RETURN FALSE; END IF;
  SELECT balance, bank_balance INTO acct FROM accounts
  WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  IF acct IS NULL OR acct.balance < p_amount THEN RETURN FALSE; END IF;
  UPDATE accounts SET balance = balance - p_amount, bank_balance = bank_balance + p_amount
  WHERE guild_id = p_guild_id AND user_id = p_user_id;
  RETURN TRUE;
END;
$$;

-- bank_withdraw(p_guild_id, p_user_id, p_amount)
CREATE OR REPLACE FUNCTION bank_withdraw(p_guild_id TEXT, p_user_id TEXT, p_amount BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE acct RECORD;
BEGIN
  IF p_amount <= 0 THEN RETURN FALSE; END IF;
  SELECT balance, bank_balance INTO acct FROM accounts
  WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  IF acct IS NULL OR acct.bank_balance < p_amount THEN RETURN FALSE; END IF;
  UPDATE accounts SET balance = balance + p_amount, bank_balance = bank_balance - p_amount
  WHERE guild_id = p_guild_id AND user_id = p_user_id;
  RETURN TRUE;
END;
$$;

-- claim_interest(p_guild_id, p_user_id, p_today) -> 이자액 (-1 계정없음, -2 이미수령)
CREATE OR REPLACE FUNCTION claim_interest(p_guild_id TEXT, p_user_id TEXT, p_today TEXT)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE acct RECORD; interest BIGINT;
BEGIN
  SELECT balance, bank_balance, last_interest_claim_date INTO acct FROM accounts
  WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  IF acct IS NULL THEN RETURN -1; END IF;
  IF acct.last_interest_claim_date = p_today THEN RETURN -2; END IF;

  interest := FLOOR(acct.bank_balance * 0.005);
  IF interest < 1 THEN interest := 0; END IF;

  UPDATE accounts SET balance = balance + interest, last_interest_claim_date = p_today
  WHERE guild_id = p_guild_id AND user_id = p_user_id;
  RETURN interest;
END;
$$;

NOTIFY pgrst, 'reload schema';
