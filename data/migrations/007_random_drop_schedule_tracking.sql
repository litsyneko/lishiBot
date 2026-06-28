-- Supabase SQL migration: track daily schedule notification for random drops
-- Run this in Supabase SQL Editor.

-- 기존 random_drops 테이블에 last_schedule_notified_date 컬럼 추가
DO $$
BEGIN
  ALTER TABLE random_drops ADD COLUMN IF NOT EXISTS last_schedule_notified_date TEXT;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
