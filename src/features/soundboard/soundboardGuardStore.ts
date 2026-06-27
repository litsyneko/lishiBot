import { getSupabase } from '../ai/supabase'
import { logger } from '../../utils/logger'

const SETTINGS_TABLE = 'soundboard_guard_settings'

const enabledCache = new Map<string, boolean>()

export function isSoundboardGuardEnabled(guildId: string): boolean {
  return enabledCache.get(guildId) ?? false
}

export async function loadSoundboardGuardSettings(): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) {
    logger.warn('SoundboardGuard', 'Supabase 미설정 - 사운드보드 가드 비활성화')
    return
  }

  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .select('guild_id, enabled')

  if (error !== null) {
    logger.error('SoundboardGuard', `설정 로드 실패: ${error.message}`)
    return
  }

  if (data !== null) {
    for (const row of data) {
      if (row.enabled === true) {
        enabledCache.set(row.guild_id, true)
      }
    }
    logger.info('SoundboardGuard', `${data.length}개 길드 설정 로드 완료`)
  }
}

export async function enableSoundboardGuard(guildId: string): Promise<void> {
  enabledCache.set(guildId, true)
  await upsert(guildId, true)
}

export async function disableSoundboardGuard(guildId: string): Promise<void> {
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
    logger.error('SoundboardGuard', `설정 저장 실패: ${error.message}`)
  }
}
