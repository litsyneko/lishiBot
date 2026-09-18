import { config } from '../config'
import { logger } from '../utils/logger'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'

// v3 TTS는 환경음을 만들지 못하므로, 효과음 태그는 Sound Effects API로
// 실제 효과음을 생성해 말소리 밑에 배경으로 깐다.
// 생성 결과는 디스크에 캐시해 재과금을 막는다.

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'sfx-cache')

// ambient = 말소리 길이에 맞춰 루프되는 배경음, oneshot = 시작에 한 번 재생
export type SfxMode = 'ambient' | 'oneshot'

type SfxEffect = {
  readonly prompt: string
  readonly seconds: number
  readonly mode: SfxMode
}

// 효과음 태그(영문 키) → 생성 프롬프트/길이/모드
const SFX_EFFECTS: Readonly<Record<string, SfxEffect>> = {
  // ── 자연·환경 (배경 루프)
  'rain sounds': {
    mode: 'ambient',
    prompt: 'steady rain falling, calm ambient rain on a window',
    seconds: 10,
  },
  thunder: {
    mode: 'ambient',
    prompt: 'thunderstorm with rumbling thunder and rain',
    seconds: 10,
  },
  'wind sounds': {
    mode: 'ambient',
    prompt: 'strong wind blowing steadily',
    seconds: 10,
  },
  'ocean waves': {
    mode: 'ambient',
    prompt: 'ocean waves rolling onto the shore',
    seconds: 10,
  },
  'birds chirping': {
    mode: 'ambient',
    prompt: 'small birds chirping in a quiet forest',
    seconds: 10,
  },
  crickets: {
    mode: 'ambient',
    prompt: 'crickets chirping on a quiet summer night',
    seconds: 10,
  },
  campfire: {
    mode: 'ambient',
    prompt: 'a campfire crackling and popping',
    seconds: 10,
  },
  stream: {
    mode: 'ambient',
    prompt: 'gentle stream water flowing over rocks',
    seconds: 10,
  },
  'city ambience': {
    mode: 'ambient',
    prompt: 'busy city street ambience with distant traffic',
    seconds: 10,
  },
  'horror ambience': {
    mode: 'ambient',
    prompt: 'eerie horror ambience with a creepy low drone',
    seconds: 10,
  },
  'clock ticking': {
    mode: 'ambient',
    prompt: 'a clock ticking in a quiet room',
    seconds: 8,
  },
  heartbeat: {
    mode: 'ambient',
    prompt: 'a slow tense heartbeat thumping',
    seconds: 8,
  },
  'drum roll': {
    mode: 'ambient',
    prompt: 'a continuous suspenseful snare drum roll',
    seconds: 8,
  },
  applause: {
    mode: 'ambient',
    prompt: 'crowd clapping and applauding',
    seconds: 6,
  },
  footsteps: {
    mode: 'ambient',
    prompt: 'footsteps walking on a wooden floor',
    seconds: 8,
  },
  fireworks: {
    mode: 'ambient',
    prompt: 'fireworks exploding and crackling in the sky',
    seconds: 8,
  },
  train: {
    mode: 'ambient',
    prompt: 'a train rolling on tracks with rhythmic clatter',
    seconds: 8,
  },
  helicopter: {
    mode: 'ambient',
    prompt: 'a helicopter hovering with rotor blades spinning',
    seconds: 8,
  },
  // ── 단발 효과 (한 번 재생)
  explosion: { mode: 'oneshot', prompt: 'a large explosion blast', seconds: 3 },
  gunshot: { mode: 'oneshot', prompt: 'a single loud gunshot', seconds: 2 },
  'door slams': {
    mode: 'oneshot',
    prompt: 'a wooden door slamming shut',
    seconds: 2,
  },
  fanfare: {
    mode: 'oneshot',
    prompt: 'a triumphant trumpet fanfare',
    seconds: 4,
  },
  'sad trombone': {
    mode: 'oneshot',
    prompt: 'a comedic sad trombone wah wah wah fail sound',
    seconds: 3,
  },
  'dramatic sting': {
    mode: 'oneshot',
    prompt: 'a dramatic orchestral sting, dun dun dun',
    seconds: 3,
  },
  'magic sparkle': {
    mode: 'oneshot',
    prompt: 'a magical sparkle chime spell sound',
    seconds: 2,
  },
  laser: { mode: 'oneshot', prompt: 'a sci-fi laser zap', seconds: 2 },
  coin: {
    mode: 'oneshot',
    prompt: 'a video game coin pickup sound',
    seconds: 2,
  },
  bell: { mode: 'oneshot', prompt: 'a bright bell ringing', seconds: 3 },
  siren: { mode: 'oneshot', prompt: 'a police siren passing by', seconds: 6 },
  alarm: {
    mode: 'oneshot',
    prompt: 'a loud warning alarm beeping',
    seconds: 4,
  },
  'wolf howl': {
    mode: 'oneshot',
    prompt: 'a wolf howling in the distance at night',
    seconds: 4,
  },
  'cat meow': { mode: 'oneshot', prompt: 'a cat meowing', seconds: 2 },
  'dog bark': { mode: 'oneshot', prompt: 'a dog barking', seconds: 3 },
  rooster: {
    mode: 'oneshot',
    prompt: 'a rooster crowing in the morning',
    seconds: 3,
  },
  scream: { mode: 'oneshot', prompt: 'a person screaming in fear', seconds: 2 },
  fart: { mode: 'oneshot', prompt: 'a comedic fart sound', seconds: 2 },
  'creaking door': {
    mode: 'oneshot',
    prompt: 'an old wooden door creaking open slowly',
    seconds: 3,
  },
  crow: { mode: 'oneshot', prompt: 'a crow cawing', seconds: 2 },
  'car horn': {
    mode: 'oneshot',
    prompt: 'a car horn honking twice',
    seconds: 2,
  },
}

// [효:자유 설명] 커스텀 효과음 문법. 설명을 그대로 생성 프롬프트로 쓴다.
const CUSTOM_PREFIX = /^(?:효|효과|sfx)\s*:\s*(.+)$/iu
const CUSTOM_SFX_SECONDS = 6
const CUSTOM_SFX_MAX_LENGTH = 60

export type SfxRequest = {
  readonly kind: 'preset' | 'custom'
  // preset이면 SFX_EFFECTS 키, custom이면 자유 설명
  readonly key: string
}

export function getSfxMode(request: SfxRequest): SfxMode {
  if (request.kind === 'custom') return 'ambient'
  return SFX_EFFECTS[request.key]?.mode ?? 'ambient'
}

export type SfxExtraction = {
  readonly effect: SfxRequest | null
  readonly cleaned: string
}

// 텍스트에서 효과음 태그를 분리한다. 첫 번째 효과음만 사용하고
// 나머지 효과음 태그는 제거(음성 태그는 그대로 둠).
export function extractSfx(text: string): SfxExtraction {
  let effect: SfxRequest | null = null
  const cleaned = text
    .replace(/\[([^\]]+)\]/gu, (match, inner: string) => {
      const custom = inner.trim().match(CUSTOM_PREFIX)
      if (custom !== null) {
        const description = custom[1].trim().slice(0, CUSTOM_SFX_MAX_LENGTH)
        if (effect === null && description.length > 0) {
          effect = { key: description, kind: 'custom' }
        }
        return ' '
      }

      const key = inner.trim().toLowerCase()
      if (SFX_EFFECTS[key] !== undefined) {
        if (effect === null) effect = { key, kind: 'preset' }
        return ' '
      }
      return match
    })
    .replace(/\s+/gu, ' ')
    .trim()
  return { effect, cleaned }
}

export async function getSfxAudio(request: SfxRequest): Promise<Buffer | null> {
  let prompt: string
  let seconds: number
  let cacheName: string

  if (request.kind === 'preset') {
    const entry = SFX_EFFECTS[request.key]
    if (entry === undefined) return null
    prompt = entry.prompt
    seconds = entry.seconds
    cacheName = request.key.replace(/[^a-z0-9]+/gu, '-')
  } else {
    prompt = request.key
    seconds = CUSTOM_SFX_SECONDS
    cacheName = `custom-${createHash('md5')
      .update(request.key)
      .digest('hex')
      .slice(0, 16)}`
  }

  const cachePath = path.join(CACHE_DIR, `${cacheName}.mp3`)

  try {
    if (existsSync(cachePath)) return readFileSync(cachePath)
  } catch {
    // 캐시 읽기 실패는 무시하고 새로 생성
  }

  const apiKey = config.elevenLabs?.apiKey
  if (apiKey === undefined || apiKey.trim().length === 0) return null

  try {
    const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
      body: JSON.stringify({
        duration_seconds: seconds,
        prompt_influence: 0.5,
        text: prompt,
      }),
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      method: 'POST',
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      logger.error(
        'TTS',
        `효과음 생성 실패(${request.key}): ${res.status} ${detail.slice(
          0,
          150
        )}`
      )
      return null
    }

    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length === 0) return null

    try {
      mkdirSync(CACHE_DIR, { recursive: true })
      writeFileSync(cachePath, buffer)
    } catch {
      // 캐시 저장 실패는 치명적이지 않음
    }

    logger.info(
      'TTS',
      `효과음 생성 완료: ${request.kind}/${request.key} (${buffer.length} bytes)`
    )
    return buffer
  } catch (err) {
    logger.error(
      'TTS',
      `효과음 요청 오류: ${err instanceof Error ? err.message : String(err)}`
    )
    return null
  }
}
