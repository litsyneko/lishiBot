-- 임시 통화방(Join-to-Create) 기능
--   temp_voice_settings : 길드별 설정(생성 채널, 카테고리, 이름 템플릿, 유예/쿨다운)
--   temp_voice_rooms    : 현재 살아있는 임시 통화방(재시작 복구용)
-- 011/014 마이그레이션과 동일한 규약: allow-all RLS + updated_at 트리거.

-- ─── 설정 ───
CREATE TABLE IF NOT EXISTS temp_voice_settings (
  guild_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  -- 이 음성 채널에 들어오면 임시 통화방이 생성된다.
  generator_channel_id TEXT,
  -- 통화방이 만들어질 카테고리. NULL이면 생성 채널과 같은 카테고리.
  category_id TEXT,
  -- 통화방 이름 템플릿. {user}=닉네임, {count}=순번.
  name_template TEXT NOT NULL DEFAULT '{user}의 통화방',
  -- 통화방 기본 인원 제한(0=무제한).
  default_user_limit INT NOT NULL DEFAULT 0,
  -- 방장이 방을 떠난 뒤 자동 위임까지의 유예(분). 0=즉시 위임.
  owner_grace_minutes INT NOT NULL DEFAULT 10,
  -- 같은 사람이 연속으로 통화방을 만드는 것을 막는 쿨다운(초).
  cooldown_seconds INT NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE temp_voice_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on temp_voice_settings" ON temp_voice_settings FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 활성 통화방 ───
CREATE TABLE IF NOT EXISTS temp_voice_rooms (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  -- 현재 방장.
  owner_id TEXT NOT NULL,
  -- 최초 생성자(방장 위임과 무관하게 기록 유지).
  created_by TEXT NOT NULL,
  -- 방장이 잠금(비공개)했는지.
  locked BOOLEAN NOT NULL DEFAULT false,
  -- 입장 차단된 유저 ID 목록.
  blocked_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE temp_voice_rooms ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on temp_voice_rooms" ON temp_voice_rooms FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_temp_voice_rooms_guild_id
  ON temp_voice_rooms(guild_id);
CREATE INDEX IF NOT EXISTS idx_temp_voice_rooms_owner
  ON temp_voice_rooms(guild_id, owner_id);

-- ─── updated_at 트리거 ───
CREATE OR REPLACE FUNCTION set_temp_voice_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_temp_voice_settings_updated_at ON temp_voice_settings;
CREATE TRIGGER trg_temp_voice_settings_updated_at
  BEFORE UPDATE ON temp_voice_settings
  FOR EACH ROW
  EXECUTE FUNCTION set_temp_voice_updated_at();

DROP TRIGGER IF EXISTS trg_temp_voice_rooms_updated_at ON temp_voice_rooms;
CREATE TRIGGER trg_temp_voice_rooms_updated_at
  BEFORE UPDATE ON temp_voice_rooms
  FOR EACH ROW
  EXECUTE FUNCTION set_temp_voice_updated_at();
