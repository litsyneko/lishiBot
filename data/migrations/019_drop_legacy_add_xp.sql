-- Supabase SQL migration: 레거시 add_xp 함수 제거
-- Run this in Supabase SQL Editor.
--
-- add_xp(p_user_id, p_xp)는 삭제된 경제 레벨 시스템(levelCard.ts)의 잔재로,
-- 코드 어디서도 호출하지 않는다. accounts를 user_id 단일 기준으로 접근하고
-- ON CONFLICT (user_id)를 쓰는데, 017에서 accounts PK가 (guild_id, user_id)로
-- 바뀌어 이제 호출되면 오류가 난다. 혼선을 없애기 위해 제거한다.

DROP FUNCTION IF EXISTS add_xp(text, bigint);

NOTIFY pgrst, 'reload schema';
