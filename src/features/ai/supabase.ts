import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { config } from '../../config'

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient | null {
  if (client !== null) return client

  const sc = config.supabase
  if (sc === undefined || !sc.url || !sc.secretKey) return null

  client = createClient(sc.url, sc.secretKey)
  return client
}

