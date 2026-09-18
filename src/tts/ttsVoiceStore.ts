import { getSupabase } from '../features/ai/supabase'
import { logger } from '../utils/logger'

const TABLE = 'tts_user_voices'

// 사용자별 선택 목소리 캐시. 미설정 사용자는 config 기본 음성을 쓴다.
const cache = new Map<string, string>()

export function getUserVoiceId(userId: string): string | undefined {
  return cache.get(userId)
}

export async function loadUserVoices(): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) {
    logger.warn('TTS', 'Supabase 미설정 - 개인 목소리 설정 비활성화')
    return
  }

  const { data, error } = await supabase.from(TABLE).select('user_id, voice_id')
  if (error !== null) {
    logger.error('TTS', `목소리 설정 로드 실패: ${error.message}`)
    return
  }

  for (const row of data ?? []) {
    cache.set(row.user_id, row.voice_id)
  }
  logger.info('TTS', `${cache.size}명의 목소리 설정 로드 완료`)
}

export async function setUserVoice(
  userId: string,
  voiceId: string
): Promise<void> {
  cache.set(userId, voiceId)

  const supabase = getSupabase()
  if (supabase === null) return

  const { error } = await supabase
    .from(TABLE)
    .upsert({ user_id: userId, voice_id: voiceId }, { onConflict: 'user_id' })

  if (error !== null) {
    logger.error('TTS', `목소리 설정 저장 실패: ${error.message}`)
  }
}
