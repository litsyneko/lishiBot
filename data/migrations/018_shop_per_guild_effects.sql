-- Supabase SQL migration: 상점을 서버(길드) 전용 + 관리자 편집형으로 전환하고
-- 아이템 효과를 effect_type 기반으로 실제 동작하게 만든다.
-- Run this in Supabase SQL Editor. (반드시 017 이후 실행)
--
--  - shop_items: (guild_id, item_id) + effect_type/effect_value/effect_max/role_id
--  - user_inventory: (guild_id, user_id, item_id)
--  - user_effects: (guild_id, user_id, effect_type) — 시간제/횟수제 버프
--  - use_shop_item: effect_type에 따라 실제 효과 적용(현금/미스터리/부스트/역할/수집품)
--  - buy_shop_item / consume_luck_boost / get_active_effects: per-guild
--  - upsert_shop_item / delete_shop_item: 관리자 상점 편집
--  - record_guild_text_xp: 경험치 2배 버프 반영
--
-- 메인 길드 ID: '1440598081648328816'

-- ============================================================
-- 1) shop_items -> (guild_id, item_id) + 효과 컬럼
-- ============================================================
ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS guild_id TEXT;
UPDATE shop_items SET guild_id = '1440598081648328816' WHERE guild_id IS NULL;
ALTER TABLE shop_items ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE shop_items DROP CONSTRAINT IF EXISTS shop_items_pkey;
ALTER TABLE shop_items ADD PRIMARY KEY (guild_id, item_id);

ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS effect_type TEXT NOT NULL DEFAULT 'collectible';
ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS effect_value BIGINT;
ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS effect_max BIGINT;
ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS role_id TEXT;

-- 기존 seed 3종의 효과 유형/파라미터/설명 정정
UPDATE shop_items SET effect_type='luck_boost', effect_value=1,
  description='다음 도박 1회에서 이기면 상금이 10% 증가해요.'
  WHERE item_id='luck_boost';
UPDATE shop_items SET effect_type='double_xp', effect_value=30,
  description='사용 후 30분간 서버 활동(채팅) 경험치가 2배로 적립돼요.'
  WHERE item_id='double_xp';
UPDATE shop_items SET effect_type='mystery_box', effect_value=5000, effect_max=100000,
  description='열면 5,000원~100,000원 중 무작위 보상을 즉시 지급받아요.'
  WHERE item_id='mystery_box';

-- ============================================================
-- 2) user_inventory -> (guild_id, user_id, item_id)
-- ============================================================
ALTER TABLE user_inventory ADD COLUMN IF NOT EXISTS guild_id TEXT;
UPDATE user_inventory SET guild_id = '1440598081648328816' WHERE guild_id IS NULL;
ALTER TABLE user_inventory ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE user_inventory DROP CONSTRAINT IF EXISTS user_inventory_pkey;
ALTER TABLE user_inventory ADD PRIMARY KEY (guild_id, user_id, item_id);

-- ============================================================
-- 3) user_effects: 사용자별 활성 효과 (per-guild)
--    expires_at: 시간제 버프 만료 시각(경험치 2배). 횟수제면 NULL.
--    charges:    횟수제 버프 잔여 횟수(도박 운 부스트). 시간제면 NULL.
-- ============================================================
CREATE TABLE IF NOT EXISTS user_effects (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  charges INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id, effect_type)
);
ALTER TABLE user_effects ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on user_effects" ON user_effects FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- 4) buy_shop_item(p_guild_id, p_user_id, p_item_id) -> 결제액 (-1 실패)
-- ============================================================
DROP FUNCTION IF EXISTS buy_shop_item(text, text);
CREATE OR REPLACE FUNCTION buy_shop_item(p_guild_id TEXT, p_user_id TEXT, p_item_id TEXT)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE item_price BIGINT; sender_balance BIGINT;
BEGIN
  SELECT price INTO item_price FROM shop_items
  WHERE guild_id = p_guild_id AND item_id = p_item_id FOR UPDATE;
  IF item_price IS NULL THEN RETURN -1; END IF;

  SELECT balance INTO sender_balance FROM accounts
  WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  IF sender_balance IS NULL THEN sender_balance := 0; END IF;
  IF sender_balance < item_price THEN RETURN -1; END IF;

  INSERT INTO accounts (guild_id, user_id, balance)
  VALUES (p_guild_id, p_user_id, -item_price)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET balance = accounts.balance - item_price;

  INSERT INTO user_inventory (guild_id, user_id, item_id, quantity, acquired_at)
  VALUES (p_guild_id, p_user_id, p_item_id, 1, now())
  ON CONFLICT (guild_id, user_id, item_id) DO UPDATE SET
    quantity = user_inventory.quantity + 1, acquired_at = now();

  RETURN item_price;
END;
$$;

-- ============================================================
-- 5) use_shop_item(p_guild_id, p_user_id, p_item_id, p_random)
--    effect_type에 따라 실제 효과 적용. 재고 1개를 원자적으로 소모.
--    status: 'cash'|'mystery'|'luck_boost'|'double_xp'|'role'|'used'|'no_item'
-- ============================================================
CREATE OR REPLACE FUNCTION use_shop_item(
  p_guild_id TEXT, p_user_id TEXT, p_item_id TEXT, p_random DOUBLE PRECISION DEFAULT 0
) RETURNS TABLE (
  status TEXT, amount BIGINT, new_balance BIGINT,
  expires_at TIMESTAMPTZ, charges INTEGER, role_id TEXT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  qty INTEGER;
  it RECORD;
  v_status TEXT := 'used';
  v_amount BIGINT := 0;
  v_new_balance BIGINT := -1;
  v_expires TIMESTAMPTZ := NULL;
  v_charges INTEGER := NULL;
  v_role TEXT := NULL;
  v_min BIGINT; v_max BIGINT; v_minutes INTEGER;
BEGIN
  SELECT quantity INTO qty FROM user_inventory
  WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = p_item_id FOR UPDATE;

  IF qty IS NULL OR qty <= 0 THEN
    RETURN QUERY SELECT 'no_item'::TEXT, 0::BIGINT, (-1)::BIGINT, NULL::TIMESTAMPTZ, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  SELECT effect_type, effect_value, effect_max, shop_items.role_id INTO it
  FROM shop_items WHERE guild_id = p_guild_id AND item_id = p_item_id;

  -- 재고 1개 소모(0이면 행 삭제)
  IF qty <= 1 THEN
    DELETE FROM user_inventory
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = p_item_id;
  ELSE
    UPDATE user_inventory SET quantity = quantity - 1
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = p_item_id;
  END IF;

  IF it.effect_type = 'mystery_box' THEN
    v_min := COALESCE(it.effect_value, 5000);
    v_max := COALESCE(it.effect_max, 100000);
    IF v_max < v_min THEN v_max := v_min; END IF;
    v_amount := LEAST(v_min + FLOOR(p_random * (v_max - v_min + 1))::BIGINT, v_max);
    v_new_balance := add_balance(p_guild_id, p_user_id, v_amount::INTEGER);
    v_status := 'mystery';
  ELSIF it.effect_type = 'cash' THEN
    v_amount := GREATEST(COALESCE(it.effect_value, 0), 0);
    IF v_amount > 0 THEN
      v_new_balance := add_balance(p_guild_id, p_user_id, v_amount::INTEGER);
    END IF;
    v_status := 'cash';
  ELSIF it.effect_type = 'luck_boost' THEN
    INSERT INTO user_effects (guild_id, user_id, effect_type, expires_at, charges, updated_at)
    VALUES (p_guild_id, p_user_id, 'luck_boost', NULL, GREATEST(COALESCE(it.effect_value, 1), 1), now())
    ON CONFLICT (guild_id, user_id, effect_type) DO UPDATE SET
      charges = COALESCE(user_effects.charges, 0) + GREATEST(COALESCE(it.effect_value, 1), 1),
      expires_at = NULL, updated_at = now()
    RETURNING user_effects.charges INTO v_charges;
    v_status := 'luck_boost';
  ELSIF it.effect_type = 'double_xp' THEN
    v_minutes := GREATEST(COALESCE(it.effect_value, 30), 1);
    INSERT INTO user_effects (guild_id, user_id, effect_type, expires_at, charges, updated_at)
    VALUES (p_guild_id, p_user_id, 'double_xp', now() + (v_minutes || ' minutes')::INTERVAL, NULL, now())
    ON CONFLICT (guild_id, user_id, effect_type) DO UPDATE SET
      expires_at = GREATEST(COALESCE(user_effects.expires_at, now()), now()) + (v_minutes || ' minutes')::INTERVAL,
      charges = NULL, updated_at = now()
    RETURNING user_effects.expires_at INTO v_expires;
    v_status := 'double_xp';
  ELSIF it.effect_type = 'role' THEN
    v_role := it.role_id;
    v_status := 'role';
  ELSE
    v_status := 'used';
  END IF;

  RETURN QUERY SELECT v_status, v_amount, v_new_balance, v_expires, v_charges, v_role;
END;
$$;

-- ============================================================
-- 6) consume_luck_boost(p_guild_id, p_user_id) -> BOOLEAN
-- ============================================================
CREATE OR REPLACE FUNCTION consume_luck_boost(p_guild_id TEXT, p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c INTEGER;
BEGIN
  SELECT charges INTO c FROM user_effects
  WHERE guild_id = p_guild_id AND user_id = p_user_id AND effect_type = 'luck_boost' FOR UPDATE;
  IF c IS NULL OR c <= 0 THEN RETURN FALSE; END IF;
  IF c <= 1 THEN
    DELETE FROM user_effects
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND effect_type = 'luck_boost';
  ELSE
    UPDATE user_effects SET charges = c - 1, updated_at = now()
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND effect_type = 'luck_boost';
  END IF;
  RETURN TRUE;
END;
$$;

-- ============================================================
-- 7) get_active_effects(p_guild_id, p_user_id)
-- ============================================================
CREATE OR REPLACE FUNCTION get_active_effects(p_guild_id TEXT, p_user_id TEXT)
RETURNS TABLE (effect_type TEXT, expires_at TIMESTAMPTZ, charges INTEGER)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT e.effect_type, e.expires_at, e.charges
  FROM user_effects e
  WHERE e.guild_id = p_guild_id AND e.user_id = p_user_id
    AND ((e.expires_at IS NOT NULL AND e.expires_at > now())
      OR (e.charges IS NOT NULL AND e.charges > 0));
END;
$$;

-- ============================================================
-- 8) 관리자 상점 편집: upsert_shop_item / delete_shop_item
-- ============================================================
CREATE OR REPLACE FUNCTION upsert_shop_item(
  p_guild_id TEXT, p_item_id TEXT, p_name TEXT, p_description TEXT,
  p_price BIGINT, p_category TEXT, p_emoji TEXT,
  p_effect_type TEXT, p_effect_value BIGINT, p_effect_max BIGINT, p_role_id TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO shop_items (guild_id, item_id, name, description, price, category, emoji,
                          effect_type, effect_value, effect_max, role_id)
  VALUES (p_guild_id, p_item_id, p_name, p_description, p_price, p_category, p_emoji,
          p_effect_type, p_effect_value, p_effect_max, p_role_id)
  ON CONFLICT (guild_id, item_id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description, price = EXCLUDED.price,
    category = EXCLUDED.category, emoji = EXCLUDED.emoji, effect_type = EXCLUDED.effect_type,
    effect_value = EXCLUDED.effect_value, effect_max = EXCLUDED.effect_max, role_id = EXCLUDED.role_id;
END;
$$;

CREATE OR REPLACE FUNCTION delete_shop_item(p_guild_id TEXT, p_item_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE removed INTEGER;
BEGIN
  DELETE FROM shop_items WHERE guild_id = p_guild_id AND item_id = p_item_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed > 0;
END;
$$;

-- ============================================================
-- 9) record_guild_text_xp: 경험치 2배(double_xp) 버프 반영 (per-guild 효과)
-- ============================================================
CREATE OR REPLACE FUNCTION record_guild_text_xp(p_guild_id TEXT, p_user_id TEXT, p_xp BIGINT)
RETURNS TABLE (level INTEGER, xp BIGINT, message_count INTEGER, leveled_up BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  before_level INTEGER; after_record RECORD; effective_xp BIGINT; has_boost BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM user_effects
    WHERE guild_id = p_guild_id AND user_id = p_user_id
      AND effect_type = 'double_xp' AND expires_at IS NOT NULL AND expires_at > now()
  ) INTO has_boost;

  effective_xp := GREATEST(p_xp, 0) * CASE WHEN has_boost THEN 2 ELSE 1 END;

  SELECT guild_text_levels.level INTO before_level
  FROM guild_text_levels
  WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;

  INSERT INTO guild_text_levels (guild_id, user_id, xp, level, message_count)
  VALUES (p_guild_id, p_user_id, effective_xp, guild_activity_level_for_xp(effective_xp), 1)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    xp = guild_text_levels.xp + effective_xp,
    level = guild_activity_level_for_xp(guild_text_levels.xp + effective_xp),
    message_count = guild_text_levels.message_count + 1
  RETURNING guild_text_levels.level, guild_text_levels.xp, guild_text_levels.message_count
  INTO after_record;

  RETURN QUERY SELECT after_record.level, after_record.xp, after_record.message_count,
    COALESCE(before_level, 1) < after_record.level;
END;
$$;

NOTIFY pgrst, 'reload schema';
