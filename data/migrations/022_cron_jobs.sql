-- ============================================================
-- 022: AI 에이전트 자율성 — cron 스케줄 (인프로세스 croner의 진실 원천)
-- Supabase SQL Editor에 붙여 실행 (이 레포는 자동 마이그레이션 러너 없음).
-- 중요: 코드는 이 테이블이 없어도 RAM/무동작으로 살아있어야 함(수동 적용 전제).
--
-- 샌드박스 원칙 (리시 지시, 2026-07-08):
--   - 시스템 스케줄러 금지. 봇 프로세스 내부 croner로만 실행 → 봇이 죽으면 같이 멈춤.
--   - cron 잡은 임의 코드/exec/shell을 부르지 못한다. kind = 안전 액션 화이트리스트만.
--   - payload는 액션 파라미터(데이터)일 뿐, 실행 코드가 아니다.
--   - 위험 액션은 cron이 트리거해도 실행 시점에 승인 게이트를 그대로 통과.
--   - 등록/수정/삭제는 관리자 한정. 진실 원천은 이 테이블 → 부팅 시 읽어 croner에 재등록.
-- ============================================================

CREATE TABLE IF NOT EXISTS cron_jobs (
  id              BIGSERIAL PRIMARY KEY,
  guild_id        TEXT NOT NULL,
  channel_id      TEXT,                                   -- 액션 결과를 보낼 채널(리마인더 등)
  kind            TEXT NOT NULL,                          -- 안전 액션 화이트리스트(reminder 등)
  schedule        TEXT NOT NULL,                          -- croner 표현식(cron) 또는 ISO(1회성)
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,     -- 액션 파라미터(임의 코드 아님)
  tz              TEXT NOT NULL DEFAULT 'Asia/Seoul',     -- 스케줄 해석 기준 타임존
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_by      TEXT NOT NULL,                          -- 등록한 관리자 user_id
  next_run_at     TIMESTAMPTZ,                            -- 다음 실행 예정(관측용)
  last_run_at     TIMESTAMPTZ,
  last_run_status TEXT,                                   -- ok | failed | skipped
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_guild ON cron_jobs (guild_id);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs (enabled);

-- ── RLS (봇은 anon key 사용, 기존 마이그레이션 패턴 그대로) ──
ALTER TABLE cron_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on cron_jobs" ON cron_jobs
  FOR ALL USING (true) WITH CHECK (true);
