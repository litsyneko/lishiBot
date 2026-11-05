import { config } from '../config'
import { logger } from '../utils/logger'
import { koreanToVoicevoxKana } from './koreanToKana'

const DEFAULT_SPEAKER_ID = '3' // 즈ンダ몬 (노말)
const DEFAULT_VOICEVOX_URL = 'http://127.0.0.1:50021'

function getVoicevoxUrl(): string {
  const url =
    (config as { voicevoxUrl?: string }).voicevoxUrl ?? DEFAULT_VOICEVOX_URL
  return url.replace(/\/+$/u, '')
}

export function isVoicevoxConfigured(): boolean {
  return true
}

export function isTtsDisabled(): boolean {
  return false
}

export function setExpirationHandler(_fn: () => void): void {
  // 로컬 API이므로 API 키 만료 없음
}

/**
 * 텍스트를 로컬 VOICEVOX 엔진을 통해 합성해 WAV 오디오 Buffer를 반환합니다.
 * 한국어 음운 최적화(한글->가타카나 변환 및 속도/억양 보정)가 자동으로 적용됩니다.
 */
export async function synthesizeSpeech(
  text: string,
  voiceId?: string
): Promise<Buffer | null> {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    logger.debug('TTS', '합성할 텍스트가 비어 있어 요청을 건너뜁니다.')
    return null
  }

  // 한글 음운 최적화 (한국어 -> VOICEVOX 친화적 가타카나)
  const optimizedText = koreanToVoicevoxKana(trimmed)
  const speaker =
    voiceId && /^\d+$/u.test(voiceId) ? voiceId : DEFAULT_SPEAKER_ID
  const baseUrl = getVoicevoxUrl()

  try {
    // 1단계: audio_query 생성
    const queryUrl = `${baseUrl}/audio_query?speaker=${speaker}&text=${encodeURIComponent(
      optimizedText
    )}`
    const queryRes = await fetch(queryUrl, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })

    if (!queryRes.ok) {
      const errText = await queryRes.text().catch(() => '')
      logger.error(
        'TTS',
        `VOICEVOX audio_query 실패 (HTTP ${queryRes.status}): ${errText}`
      )
      return null
    }

    const queryData = (await queryRes.json()) as {
      speedScale: number
      intonationScale: number
    }

    // 한국어 발음 늘어짐 방지 및 자연스러운 억양 보정
    queryData.speedScale = 1.08
    queryData.intonationScale = 1.15

    // 2단계: 음성 합성
    const synthUrl = `${baseUrl}/synthesis?speaker=${speaker}`
    const synthRes = await fetch(synthUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/wav',
      },
      body: JSON.stringify(queryData),
    })

    if (!synthRes.ok) {
      const errText = await synthRes.text().catch(() => '')
      logger.error(
        'TTS',
        `VOICEVOX synthesis 실패 (HTTP ${synthRes.status}): ${errText}`
      )
      return null
    }

    const arrayBuffer = await synthRes.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch (error) {
    logger.error(
      'TTS',
      `VOICEVOX 합성 연결 오류: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return null
  }
}
