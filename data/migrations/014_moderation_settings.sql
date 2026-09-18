-- Supabase SQL migration: moderation_settings
-- Run this in Supabase SQL Editor.
-- 길드별 자동 검열 설정을 저장한다. 미설정 길드는 코드 기본값을 따른다.
--   enabled              : 마스터 on/off
--   disabled_categories  : 꺼진 검열 카테고리 (기본은 전부 on)
--   exempt_channels      : 검열 제외 채널 ID 목록
--   immune_roles         : 면제 역할 ID 목록 (비어있으면 코드 기본값 사용)
--   min_severity         : 조치할 최소 심각도 (low|medium|high)
--   timeout_enabled      : 타임아웃 적용 여부 (false면 삭제만)

CREATE TABLE IF NOT EXISTS moderation_settings (
  guild_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  disabled_categories TEXT[] NOT NULL DEFAULT '{}',
  exempt_channels TEXT[] NOT NULL DEFAULT '{}',
  immune_roles TEXT[] NOT NULL DEFAULT '{}',
  min_severity TEXT NOT NULL DEFAULT 'low',
  timeout_enabled BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE moderation_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on moderation_settings" ON moderation_settings FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_moderation_settings_guild_id
  ON moderation_settings(guild_id);
