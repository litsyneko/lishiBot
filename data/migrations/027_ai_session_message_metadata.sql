-- AI 대화 메시지의 이미지 첨부 URL과 원본 메시지 정보를 보존한다.
-- 기존 ai_session_messages 행은 빈 metadata로 읽혀 이전 세션과 호환된다.
ALTER TABLE public.ai_session_messages
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
