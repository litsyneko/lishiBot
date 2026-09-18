-- 임시 통화방 로그 채널: 생성/삭제/방장이전/내보내기 등 이벤트를 남길 텍스트 채널.
ALTER TABLE temp_voice_settings
  ADD COLUMN IF NOT EXISTS log_channel_id TEXT;
