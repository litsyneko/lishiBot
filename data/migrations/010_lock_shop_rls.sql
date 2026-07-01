DROP POLICY IF EXISTS "Allow all on shop_items" ON public.shop_items;
DROP POLICY IF EXISTS "Allow all on user_inventory" ON public.user_inventory;

ALTER TABLE public.shop_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_inventory ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
