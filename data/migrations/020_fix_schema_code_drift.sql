-- Supabase SQL migration: Fix schema-code drift for economy and music features
-- Run this in Supabase SQL Editor (반드시 019 이후 실행).
--
-- TypeScript 코드와 RPC 함수가 참조하지만 실제로는 없는 DB 객체/컬럼을 추가한다.
--  - accounts:    bank_balance, attendance_streak, last_attendance_date, last_interest_claim_date
--  - random_drops: mention_role_id
--  - music_settings: bot_id, volume, repeat_mode, controller_tab, queue_visible + 복합 PK
--  - random_drop_schedule: 새 테이블 (길드별 예약 발송 시각)

-- ============================================================
-- 1) accounts: 은행/출석/이자 컬럼
--    bank_deposit/bank_withdraw → bank_balance
--    claim_interest              → bank_balance, last_interest_claim_date
--    claim_attendance            → attendance_streak, last_attendance_date
-- ============================================================
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bank_balance BIGINT NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS attendance_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_attendance_date TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_interest_claim_date TEXT;

-- ============================================================
-- 2) random_drops: 선착 보상 알림 역할
--    getRandomDropSettings/setRandomDropSettings → mention_role_id
-- ============================================================
ALTER TABLE random_drops ADD COLUMN IF NOT EXISTS mention_role_id TEXT;

-- ============================================================
-- 3) music_settings: 길드별 음악 설정 영속화
--    getSettings가 guild_id+bot_id로 조회, patchSettings가 upsert(onConflict guild_id,bot_id)
--    기존 PK(guild_id) → 복합 PK(guild_id, bot_id) 로 변경
-- ============================================================
ALTER TABLE music_settings ADD COLUMN IF NOT EXISTS bot_id TEXT NOT NULL DEFAULT 'main';
ALTER TABLE music_settings ADD COLUMN IF NOT EXISTS volume INTEGER;
ALTER TABLE music_settings ADD COLUMN IF NOT EXISTS repeat_mode TEXT;
ALTER TABLE music_settings ADD COLUMN IF NOT EXISTS controller_tab TEXT;
ALTER TABLE music_settings ADD COLUMN IF NOT EXISTS queue_visible BOOLEAN;

-- 기존 PK 제거 후 복합 PK 재설정
ALTER TABLE music_settings DROP CONSTRAINT IF EXISTS music_settings_pkey;
ALTER TABLE music_settings ADD PRIMARY KEY (guild_id, bot_id);

-- ============================================================
-- 4) random_drop_schedule: 길드별 예약 드롭 시간대
--    getScheduledDropHours/setScheduledDropHours가 참조
--    upsert는 (guild_id, drop_date) 기준
-- ============================================================
CREATE TABLE IF NOT EXISTS random_drop_schedule (
  guild_id TEXT NOT NULL,
  drop_date TEXT NOT NULL,
  scheduled_hours INTEGER[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (guild_id, drop_date)
);

ALTER TABLE random_drop_schedule ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on random_drop_schedule" ON random_drop_schedule FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_random_drop_schedule_guild
  ON random_drop_schedule(guild_id);

-- ============================================================
-- 5) PostgREST 스키마 캐시 갱신
-- ============================================================
NOTIFY pgrst, 'reload schema';
