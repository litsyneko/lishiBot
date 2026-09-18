import { config } from '../config'
import { logger } from '../utils/logger'

const DEFAULT_MODEL_ID = 'eleven_v3'
const OUTPUT_FORMAT = 'mp3_44100_128'

export function isElevenLabsConfigured(): boolean {
  const cfg = config.elevenLabs
  return (
    cfg !== undefined &&
    cfg.apiKey.trim().length > 0 &&
    cfg.voiceId.trim().length > 0
  )
}

// API 키 만료/인증 실패로 TTS가 비활성화됐는지. 한 번 만료되면 재시작 전까지 유지.
let ttsDisabled = false
let expirationHandler: (() => void) | undefined

export function isTtsDisabled(): boolean {
  return ttsDisabled
}

// 만료 감지 시 실행할 훅(세션 종료·안내 담당). index.ts가 등록한다.
export function setExpirationHandler(fn: () => void): void {
  expirationHandler = fn
}

function markExpired(reason: string): void {
  if (ttsDisabled) return
  ttsDisabled = true
  logger.error(
    'TTS',
    `ElevenLabs API 만료/인증 실패 감지 — TTS 비활성화 (${reason})`
  )
  try {
    expirationHandler?.()
  } catch (err) {
    logger.warn(
      'TTS',
      `만료 핸들러 오류: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

// 텍스트를 ElevenLabs로 합성해 MP3 오디오 Buffer를 반환한다. 실패 시 null.
// voiceId를 넘기면 해당 목소리로, 없으면 config 기본 음성으로 합성한다.
export async function synthesizeSpeech(
  text: string,
  voiceId?: string
): Promise<Buffer | null> {
  const cfg = config.elevenLabs
  if (cfg === undefined || !isElevenLabsConfigured()) {
    logger.debug('TTS', 'ElevenLabs 미설정 - 합성 스킵')
    return null
  }

  // 이미 만료로 비활성화됐으면 죽은 API를 다시 두드리지 않는다.
  if (ttsDisabled) return null

  // 빈 텍스트는 ElevenLabs 400 validation_error(invalid_parameters)를
  // 유발하므로 합성 전에 걸러낸다.
  if (text.trim().length === 0) {
    logger.debug(
      'TTS',
      'ElevenLabs 합성할 텍스트가 비어 있어 요청을 건너뜁니다.'
    )
    return null
  }

  const modelId = cfg.modelId ?? DEFAULT_MODEL_ID
  const targetVoiceId = voiceId ?? cfg.voiceId
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${targetVoiceId}?output_format=${OUTPUT_FORMAT}`

  // v3 stability: 0.0(Creative)=태그 반응 최대, 0.5(Natural), 1.0(Robust)=태그 무시.
  // 오디오 태그 연기가 핵심이므로 기본 Creative.
  const stability = cfg.stability ?? 0.0

  try {
    const res = await fetch(url, {
      body: JSON.stringify({
        model_id: modelId,
        text,
        voice_settings: { stability },
      }),
      headers: {
        Accept: 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': cfg.apiKey,
      },
      method: 'POST',
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // 401/403(키 무효·만료) 또는 quota 소진 → TTS 비활성화 트리거.
      // 그 외(일시적 5xx 등)는 이번 합성만 실패로 두고 유지.
      if (
        res.status === 401 ||
        res.status === 403 ||
        /quota_exceeded|invalid_api_key|expired|unusual_activity/i.test(detail)
      ) {
        markExpired(`HTTP ${res.status}`)
      }
      logger.error(
        'TTS',
        `ElevenLabs 합성 실패: ${res.status} ${detail.slice(0, 200)}`
      )
      return null
    }

    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length === 0) return null
    return buffer
  } catch (err) {
    logger.error(
      'TTS',
      `ElevenLabs 요청 오류: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return null
  }
}
