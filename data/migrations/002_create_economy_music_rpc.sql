-- Supabase SQL migration: economy (accounts) + music_settings + RPC functions
-- Run this in Supabase SQL Editor.

-- ============================================================
-- accounts table
-- ============================================================
CREATE TABLE IF NOT EXISTS accounts (
  user_id TEXT PRIMARY KEY,
  balance BIGINT NOT NULL DEFAULT 0,
  attendance_date TEXT
);

-- ============================================================
-- music_settings table
-- ============================================================
CREATE TABLE IF NOT EXISTS music_settings (
  guild_id TEXT PRIMARY KEY,
  dj_channel_id TEXT
);

-- ============================================================
-- RLS policies (allow access via service role key)
-- ============================================================
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on accounts" ON accounts FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE music_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on music_settings" ON music_settings FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- RPC: add_balance(p_user_id, p_amount) RETURNS new balance
-- Ensures account row exists, then increments atomically.
-- ============================================================
CREATE OR REPLACE FUNCTION add_balance(p_user_id TEXT, p_amount INTEGER)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_balance BIGINT;
BEGIN
  INSERT INTO accounts (user_id, balance, attendance_date)
  VALUES (p_user_id, p_amount, NULL)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = accounts.balance + p_amount
  RETURNING balance INTO new_balance;

  RETURN new_balance;
END;
$$;

-- ============================================================
-- RPC: transfer_balance(p_from, p_to, p_amount) RETURNS BOOLEAN
-- Atomic transfer. Returns FALSE if insufficient balance.
-- ============================================================
CREATE OR REPLACE FUNCTION transfer_balance(
  p_from_user_id TEXT,
  p_to_user_id TEXT,
  p_amount INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  sender_balance BIGINT;
BEGIN
  SELECT balance INTO sender_balance FROM accounts WHERE user_id = p_from_user_id FOR UPDATE;

  IF sender_balance IS NULL THEN
    sender_balance := 0;
  END IF;

  IF sender_balance < p_amount THEN
    RETURN FALSE;
  END IF;

  INSERT INTO accounts (user_id, balance, attendance_date)
  VALUES (p_from_user_id, -p_amount, NULL)
  ON CONFLICT (user_id) DO UPDATE SET balance = accounts.balance - p_amount;

  INSERT INTO accounts (user_id, balance, attendance_date)
  VALUES (p_to_user_id, p_amount, NULL)
  ON CONFLICT (user_id) DO UPDATE SET balance = accounts.balance + p_amount;

  RETURN TRUE;
END;
$$;

-- ============================================================
-- RPC: claim_attendance(p_user_id, p_today, p_reward) RETURNS BOOLEAN
-- Atomic attendance claim. Returns FALSE if already claimed today.
-- ============================================================
CREATE OR REPLACE FUNCTION claim_attendance(
  p_user_id TEXT,
  p_today TEXT,
  p_reward INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_date TEXT;
BEGIN
  SELECT attendance_date INTO current_date FROM accounts WHERE user_id = p_user_id FOR UPDATE;

  IF current_date IS NULL THEN
    INSERT INTO accounts (user_id, balance, attendance_date)
    VALUES (p_user_id, p_reward, p_today)
    ON CONFLICT (user_id) DO UPDATE
      SET attendance_date = p_today,
          balance = accounts.balance + p_reward;
    RETURN TRUE;
  END IF;

  IF current_date = p_today THEN
    RETURN FALSE;
  END IF;

  UPDATE accounts
    SET attendance_date = p_today,
        balance = balance + p_reward
  WHERE user_id = p_user_id;

  RETURN TRUE;
END;
$$;
