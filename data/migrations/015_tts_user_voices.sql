-- Supabase SQL migration: tts_user_voices
-- Run this in Supabase SQL Editor. (MCP로 이미 적용됨)
-- 사용자별 TTS 목소리 선택을 저장한다. 미설정 사용자는 config 기본 음성 사용.

CREATE TABLE IF NOT EXISTS tts_user_voices (
  user_id TEXT PRIMARY KEY,
  voice_id TEXT NOT NULL
);

ALTER TABLE tts_user_voices ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on tts_user_voices" ON tts_user_voices FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_tts_user_voices_user_id
  ON tts_user_voices(user_id);
