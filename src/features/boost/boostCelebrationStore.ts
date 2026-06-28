import { logger } from '../../utils/logger'
import { getSupabase } from '../ai/supabase'

const SETTINGS_TABLE = 'boost_celebration_settings'

const enabledCache = new Map<string, boolean>()

export function isBoostCelebrationEnabled(guildId: string): boolean {
  return enabledCache.get(guildId) ?? false
}

export async function loadBoostCelebrationSettings(): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) {
    logger.warn('BoostCelebration', 'Supabase 미설정 - 부스트 축하 비활성화')
    return
  }

  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .select('guild_id, enabled')

  if (error !== null) {
    logger.error('BoostCelebration', `설정 로드 실패: ${error.message}`)
    return
  }

  if (data !== null) {
    for (const row of data) {
      if (row.enabled === true) {
        enabledCache.set(row.guild_id, true)
      }
    }
    logger.info('BoostCelebration', `${data.length}개 길드 설정 로드 완료`)
  }
}

export async function enableBoostCelebration(guildId: string): Promise<void> {
  enabledCache.set(guildId, true)
  await upsert(guildId, true)
}

export async function disableBoostCelebration(guildId: string): Promise<void> {
  enabledCache.delete(guildId)
  await upsert(guildId, false)
}

async function upsert(guildId: string, enabled: boolean): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) return

  const { error } = await supabase
    .from(SETTINGS_TABLE)
    .upsert({ guild_id: guildId, enabled }, { onConflict: 'guild_id' })

  if (error !== null) {
    logger.error('BoostCelebration', `설정 저장 실패: ${error.message}`)
  }
}
