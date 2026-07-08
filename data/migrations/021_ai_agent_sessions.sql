-- ============================================================
-- 021: AI 에이전트 기반 — 세션 영속 + 서버 프로필
-- Supabase SQL Editor에 붙여 실행 (이 레포는 자동 마이그레이션 러너 없음).
-- 중요: 코드는 이 테이블들이 없어도 RAM fallback으로 살아있어야 함.
--       (수동 적용 전제 → 테이블 부재 시 AI가 죽으면 안 됨)
--
-- 담긴 것:
--   ai_sessions          : 세션 영속. 키 = guild:channel:user (채널 분리)
--   ai_session_messages  : 세션별 대화 원장 (user/assistant/summary)
--   server_profile       : FullMoon 서버 이해 + self model + 승인 정책 + 허용 유저
--
-- 의도적 제외:
--   user_memories.embedding — 임베딩 모델 미확정. vector(N) 차원 고정 금지.
--                             모델 확정 후 별도 마이그레이션에서 추가.
-- ============================================================

-- ── 세션 영속 (RAM Map → write-through 캐시의 소유 스토어) ──
CREATE TABLE IF NOT EXISTS ai_sessions (
  session_key         TEXT PRIMARY KEY,                    -- guild:channel:user
  guild_id            TEXT NOT NULL,
  channel_id          TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  session_started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),  -- daily 롤오버 기준(KST)
  last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- idle 만료 기준
  tool_history        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 최근 도구 실행 기록
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_guild_channel
  ON ai_sessions (guild_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_last_interaction
  ON ai_sessions (last_interaction_at);

CREATE TABLE IF NOT EXISTS ai_session_messages (
  id                  BIGSERIAL PRIMARY KEY,
  session_key         TEXT NOT NULL
                        REFERENCES ai_sessions(session_key) ON DELETE CASCADE,
  role                TEXT NOT NULL,                        -- user | assistant | summary
  content             TEXT NOT NULL,
  discord_message_id  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_session_messages_key
  ON ai_session_messages (session_key, created_at);

-- ── 서버 프로필 (서버 이해 + self model + 승인 정책, guild 단위) ──
-- FullMoon 전용이라 self model을 별도 테이블로 쪼개지 않고 여기에 흡수.
CREATE TABLE IF NOT EXISTS server_profile (
  guild_id         TEXT PRIMARY KEY,
  concept          TEXT,                                   -- 서버 컨셉/정체성(자연어)
  channel_roles    JSONB NOT NULL DEFAULT '{}'::jsonb,     -- {channelId: 용도 | quiet}
  approval_policy  JSONB NOT NULL DEFAULT '{}'::jsonb,     -- 위험작업 승인자/게이트 규칙
  allowed_users    JSONB NOT NULL DEFAULT '[]'::jsonb,     -- 허용 유저(리시/설연)
  agent_scope      JSONB NOT NULL DEFAULT '{}'::jsonb,     -- self model: 허용 범위/조용채널
  onboarded_at     TIMESTAMPTZ,                            -- 온보딩 완료 시각(미완=NULL)
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── RLS (봇은 anon key 사용, 기존 마이그레이션 패턴 그대로) ──
ALTER TABLE ai_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_session_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE server_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on ai_sessions" ON ai_sessions
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on ai_session_messages" ON ai_session_messages
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on server_profile" ON server_profile
  FOR ALL USING (true) WITH CHECK (true);
