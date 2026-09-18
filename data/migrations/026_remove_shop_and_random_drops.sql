-- 026: 선착 보상(랜덤 드랍) 및 상점 시스템 제거
--
-- 전제 조건: 봇 코드에서 선착 보상·상점 기능이 완전히 제거되었다.
-- 이 마이그레이션은 다음을 수행한다:
--   1) 함수 먼저 정리 (테이블 DROP 전 의존 제거)
--      - record_guild_text_xp에서 user_effects(double_xp 버프) 참조만 제거한
--        버전으로 교체 (라이브 정의 기준, 시그니처 (p_guild_id, p_user_id, p_xp) 유지)
--      - 상점·드랍 관련 RPC 8종 DROP
--   2) 테이블 7종 DROP
--   3) 스키마 새로고침
--
-- 주의: 되돌릴 수 없다. 인벤토리/지급 이력이 필요하면 실행 전 백업할 것.
-- 실행 위치: Supabase SQL Editor

-- ============================================================
-- 1. 함수 정리 (테이블 DROP 전에 의존 관계를 끊는다)
-- ============================================================

-- 1-1. record_guild_text_xp 교체.
--      018이 user_effects(double_xp 버프)를 참조하도록 바꿨지만,
--      상점 제거로 버프 공급원이 사라졌으므로 버프 배수 로직만 제거한다.
--      레벨 시스템(레벨 계산·메시지 카운트·레벨업 반환)은 그대로 유지.
CREATE OR REPLACE FUNCTION public.record_guild_text_xp(p_guild_id text, p_user_id text, p_xp bigint)
 RETURNS TABLE(level integer, xp bigint, message_count integer, leveled_up boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE before_level INTEGER; after_record RECORD; effective_xp BIGINT;
BEGIN
  effective_xp := GREATEST(p_xp, 0);
  SELECT guild_text_levels.level INTO before_level FROM guild_text_levels
  WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  INSERT INTO guild_text_levels (guild_id, user_id, xp, level, message_count)
  VALUES (p_guild_id, p_user_id, effective_xp, guild_activity_level_for_xp(effective_xp), 1)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    xp = guild_text_levels.xp + effective_xp,
    level = guild_activity_level_for_xp(guild_text_levels.xp + effective_xp),
    message_count = guild_text_levels.message_count + 1
  RETURNING guild_text_levels.level, guild_text_levels.xp, guild_text_levels.message_count INTO after_record;
  RETURN QUERY SELECT after_record.level, after_record.xp, after_record.message_count,
    COALESCE(before_level, 1) < after_record.level;
END;
$function$;

-- 1-2. 상점 RPC 제거 (2026-08 실측 시그니처 기준. IF EXISTS로 안전하게)
DROP FUNCTION IF EXISTS buy_shop_item(TEXT, TEXT);                       -- 009 구버전 (이미 없을 수 있음)
DROP FUNCTION IF EXISTS buy_shop_item(TEXT, TEXT, TEXT);                 -- 018 per-guild
DROP FUNCTION IF EXISTS use_shop_item(TEXT, TEXT, TEXT, DOUBLE PRECISION);
DROP FUNCTION IF EXISTS use_shop_item(TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION);
DROP FUNCTION IF EXISTS consume_luck_boost(TEXT, TEXT);
DROP FUNCTION IF EXISTS get_active_effects(TEXT, TEXT);
DROP FUNCTION IF EXISTS upsert_shop_item(TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, BIGINT, BIGINT, TEXT);
DROP FUNCTION IF EXISTS delete_shop_item(TEXT, TEXT);

-- 1-3. 선착 보상(랜덤 드랍) RPC 제거
DROP FUNCTION IF EXISTS record_drop_claim(TEXT, TEXT, BIGINT);
DROP FUNCTION IF EXISTS get_drop_leaderboard(TEXT, INTEGER);

-- ============================================================
-- 2. 테이블 제거
-- ============================================================

-- 상점
DROP TABLE IF EXISTS user_effects;
DROP TABLE IF EXISTS user_inventory;
DROP TABLE IF EXISTS shop_items;

-- 선착 보상 (랜덤 드랍)
DROP TABLE IF EXISTS random_drop_stats;
DROP TABLE IF EXISTS random_drop_claims;
DROP TABLE IF EXISTS random_drop_schedule;
DROP TABLE IF EXISTS random_drops;

-- 스키마 새로고침 (기존 마이그레이션 관례)
NOTIFY pgrst, 'reload schema';
