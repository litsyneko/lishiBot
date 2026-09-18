-- ============================================================
-- 016: 서버 관리 명령용 RPC
-- admin_subtract_balance: 잔액 차감 (0 바닥). 실제 차감액과 새 잔액 반환.
-- adjust_guild_level_xp: 서버 활동 레벨 XP 조정 (0 바닥) + 레벨 재계산.
-- ============================================================

CREATE OR REPLACE FUNCTION admin_subtract_balance(
  p_user_id TEXT,
  p_amount INTEGER
)
RETURNS TABLE (subtracted BIGINT, new_balance BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_old BIGINT;
  v_new BIGINT;
BEGIN
  INSERT INTO accounts (user_id, balance, attendance_date)
  VALUES (p_user_id, 0, NULL)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT accounts.balance INTO v_old
  FROM accounts
  WHERE accounts.user_id = p_user_id
  FOR UPDATE;

  v_new := GREATEST(0, v_old - p_amount);

  UPDATE accounts SET balance = v_new WHERE accounts.user_id = p_user_id;

  RETURN QUERY SELECT v_old - v_new, v_new;
END;
$$;

CREATE OR REPLACE FUNCTION adjust_guild_level_xp(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_track TEXT,
  p_delta BIGINT
)
RETURNS TABLE (level INTEGER, xp BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_level INTEGER;
  v_xp BIGINT;
BEGIN
  IF p_track = 'text' THEN
    INSERT INTO guild_text_levels (guild_id, user_id, xp, level, message_count)
    VALUES (
      p_guild_id,
      p_user_id,
      GREATEST(p_delta, 0),
      guild_activity_level_for_xp(GREATEST(p_delta, 0)),
      0
    )
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      xp = GREATEST(0, guild_text_levels.xp + p_delta),
      level = guild_activity_level_for_xp(
        GREATEST(0, guild_text_levels.xp + p_delta)
      )
    RETURNING guild_text_levels.level, guild_text_levels.xp
    INTO v_level, v_xp;
  ELSIF p_track = 'voice' THEN
    INSERT INTO guild_voice_levels (
      guild_id, user_id, xp, level, total_seconds, session_count
    )
    VALUES (
      p_guild_id,
      p_user_id,
      GREATEST(p_delta, 0),
      guild_activity_level_for_xp(GREATEST(p_delta, 0)),
      0,
      0
    )
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      xp = GREATEST(0, guild_voice_levels.xp + p_delta),
      level = guild_activity_level_for_xp(
        GREATEST(0, guild_voice_levels.xp + p_delta)
      )
    RETURNING guild_voice_levels.level, guild_voice_levels.xp
    INTO v_level, v_xp;
  ELSE
    RAISE EXCEPTION 'unknown track: %', p_track;
  END IF;

  RETURN QUERY SELECT v_level, v_xp;
END;
$$;
