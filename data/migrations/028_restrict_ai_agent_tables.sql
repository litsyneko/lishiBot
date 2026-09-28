-- AI 대화 기록과 서버 프로필은 봇의 서버 측 service-role/secret 키만 접근한다.
-- 기존 021 마이그레이션의 PUBLIC 허용 정책과 anon/authenticated 권한을 제거한다.
DROP POLICY IF EXISTS "Allow all on ai_sessions" ON public.ai_sessions;
DROP POLICY IF EXISTS "Allow all on ai_session_messages" ON public.ai_session_messages;
DROP POLICY IF EXISTS "Allow all on server_profile" ON public.server_profile;

REVOKE ALL ON TABLE public.ai_sessions, public.ai_session_messages, public.server_profile
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.ai_sessions, public.ai_session_messages, public.server_profile
  TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ai_session_messages_id_seq TO service_role;

CREATE POLICY "Service role only on ai_sessions" ON public.ai_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role only on ai_session_messages" ON public.ai_session_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role only on server_profile" ON public.server_profile
  FOR ALL TO service_role USING (true) WITH CHECK (true);
