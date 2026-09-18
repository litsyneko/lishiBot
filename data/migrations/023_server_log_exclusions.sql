-- 서버 로그 예외 목록(채널/유저/역할) 저장 컬럼
-- 형식: {"channels": ["..."], "users": ["..."], "roles": ["..."]}
ALTER TABLE server_log_settings
  ADD COLUMN IF NOT EXISTS exclusions JSONB NOT NULL DEFAULT '{}'::jsonb;
