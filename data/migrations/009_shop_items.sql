-- Supabase SQL migration: shop items + user inventory
-- Run this in Supabase SQL Editor.

-- ============================================================
-- shop_items: 판매 중인 아이템 카탈로그
-- ============================================================
CREATE TABLE IF NOT EXISTS shop_items (
  item_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price BIGINT NOT NULL,
  category TEXT NOT NULL,
  emoji TEXT NOT NULL
);

ALTER TABLE shop_items ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on shop_items" ON shop_items FOR ALL USING (true) WITH CHECK (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- user_inventory: 사용자별 보유 아이템
-- ============================================================
CREATE TABLE IF NOT EXISTS user_inventory (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);

ALTER TABLE user_inventory ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all on user_inventory" ON user_inventory FOR ALL USING (true) WITH CHECK (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- seed items (idempotent upsert)
-- ============================================================
INSERT INTO shop_items (item_id, name, description, price, category, emoji) VALUES
  ('luck_boost', '도박 운 부스트', '다음 도박에서 행운이 +10% 증가해요.', 50000, '부스트', '🍀'),
  ('double_xp', '경험치 2배', '30분간 경험치가 2배로 적립돼요.', 30000, '부스트', '⚡'),
  ('mystery_box', '미스터리 상자', '열면 5,000원~100,000원 중 무작위 보상을 받아요.', 20000, '상자', '🎁')
ON CONFLICT (item_id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  category = EXCLUDED.category,
  emoji = EXCLUDED.emoji;

-- ============================================================
-- RPC: buy_shop_item(p_user_id, p_item_id) RETURNS BIGINT
-- 원자적 구매. 잔액 부족/존재하지 않는 아이템이면 -1.
-- 성공 시 실제 결제 금액(price) 반환.
-- ============================================================
CREATE OR REPLACE FUNCTION buy_shop_item(
  p_user_id TEXT,
  p_item_id TEXT
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  item_price BIGINT;
  sender_balance BIGINT;
BEGIN
  SELECT price INTO item_price FROM shop_items WHERE item_id = p_item_id FOR UPDATE;

  IF item_price IS NULL THEN
    RETURN -1;
  END IF;

  SELECT balance INTO sender_balance FROM accounts WHERE user_id = p_user_id FOR UPDATE;

  IF sender_balance IS NULL THEN
    sender_balance := 0;
  END IF;

  IF sender_balance < item_price THEN
    RETURN -1;
  END IF;

  INSERT INTO accounts (user_id, balance, attendance_date)
  VALUES (p_user_id, -item_price, NULL)
  ON CONFLICT (user_id) DO UPDATE SET balance = accounts.balance - item_price;

  INSERT INTO user_inventory (user_id, item_id, quantity, acquired_at)
  VALUES (p_user_id, p_item_id, 1, now())
  ON CONFLICT (user_id, item_id) DO UPDATE SET
    quantity = user_inventory.quantity + 1,
    acquired_at = now();

  RETURN item_price;
END;
$$;
