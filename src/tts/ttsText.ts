import {
  checkBannedWords,
  checkNsfwWords,
} from '../features/moderation/moderationFilters'

// 채팅 메시지를 음성으로 읽기 좋게 정제한다.
// URL·코드블록·멘션·이모지·마크다운 기호를 제거하거나 단순화한다.

const MAX_TTS_LENGTH = 350

const KOREAN_HOUR_READINGS: Readonly<Record<string, string>> = {
  '0': '자정',
  '1': '한',
  '2': '두',
  '3': '세',
  '4': '네',
  '5': '다섯',
  '6': '여섯',
  '7': '일곱',
  '8': '여덟',
  '9': '아홉',
  '10': '열',
  '11': '열한',
  '12': '열두',
  '13': '열세',
  '14': '열네',
  '15': '열다섯',
  '16': '열여섯',
  '17': '열일곱',
  '18': '열여덟',
  '19': '열아홉',
  '20': '스무',
  '21': '스물한',
  '22': '스물두',
  '23': '스물세',
  '24': '스물네',
}

const KOREAN_HOUR_VALUE = '(?:00|0|0?[1-9]|1\\d|2[0-4])'
const KOREAN_HOUR_RANGE_PATTERN = new RegExp(
  `(^|[^\\d])(${KOREAN_HOUR_VALUE})\\s*[-~]\\s*(${KOREAN_HOUR_VALUE})\\s*시`,
  'gu'
)
const KOREAN_HOUR_PATTERN = new RegExp(
  `(^|[^\\d])(${KOREAN_HOUR_VALUE})\\s*시`,
  'gu'
)
const KOREAN_WON_AMOUNT_PATTERN = /(^|[^\d])((?:\d{1,3}(?:,\d{3})+|\d+))\s*원/gu
const KOREAN_NUMBER_DIGITS = [
  '',
  '일',
  '이',
  '삼',
  '사',
  '오',
  '육',
  '칠',
  '팔',
  '구',
] as const
const KOREAN_NUMBER_SMALL_UNITS = ['', '십', '백', '천'] as const
const KOREAN_NUMBER_BIG_UNITS = ['', '만', '억', '조'] as const

function getKoreanHourReading(hour: string): string | undefined {
  return KOREAN_HOUR_READINGS[String(Number(hour))]
}

function formatKoreanHour(hour: string): string | undefined {
  const reading = getKoreanHourReading(hour)
  if (reading === undefined) return undefined
  return Number(hour) === 0 ? reading : `${reading} 시`
}

function joinKoreanHourPrefix(prefix: string, value: string): string {
  return /[\p{L}\p{N}]/u.test(prefix)
    ? `${prefix} ${value}`
    : `${prefix}${value}`
}

function normalizeKoreanHours(text: string): string {
  return text
    .replace(
      KOREAN_HOUR_RANGE_PATTERN,
      (_match, prefix: string, start: string, end: string) => {
        const startReading = formatKoreanHour(start)
        const endReading = formatKoreanHour(end)
        if (startReading === undefined || endReading === undefined) {
          return _match
        }
        return joinKoreanHourPrefix(
          prefix,
          `${startReading}부터 ${endReading}까지`
        )
      }
    )
    .replace(KOREAN_HOUR_PATTERN, (_match, prefix: string, hour: string) => {
      const reading = formatKoreanHour(hour)
      if (reading === undefined) return _match
      return joinKoreanHourPrefix(prefix, reading)
    })
}

function readKoreanFourDigitNumber(value: number): string {
  return [1000, 100, 10, 1]
    .map((unit, index) => {
      const digit = Math.floor(value / unit) % 10
      if (digit === 0) return ''
      const unitName = KOREAN_NUMBER_SMALL_UNITS[3 - index]
      const digitName =
        digit === 1 && unitName.length > 0 ? '' : KOREAN_NUMBER_DIGITS[digit]
      return `${digitName}${unitName}`
    })
    .join('')
}

function readKoreanNumber(rawNumber: string): string | undefined {
  let remaining = BigInt(rawNumber)
  if (remaining === 0n) return '영'

  const chunks: number[] = []
  while (remaining > 0n) {
    chunks.push(Number(remaining % 10000n))
    remaining /= 10000n
  }
  if (chunks.length > KOREAN_NUMBER_BIG_UNITS.length) return undefined

  const parts: string[] = []
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index]
    if (chunk === 0) continue
    const unit = KOREAN_NUMBER_BIG_UNITS[index]
    const reading = readKoreanFourDigitNumber(chunk)
    parts.push(chunk === 1 && unit === '만' ? unit : `${reading}${unit}`)
  }
  return parts.join('')
}

function normalizeKoreanWonAmounts(text: string): string {
  return text.replace(
    KOREAN_WON_AMOUNT_PATTERN,
    (match, prefix: string, amount: string) => {
      const reading = readKoreanNumber(amount.replace(/,/gu, ''))
      if (reading === undefined) return match
      return `${prefix}${reading} 원`
    }
  )
}

// 한글 태그 → ElevenLabs v3 오디오 태그. 효과음은 실험적 기능이라
// 생성마다 품질이 다를 수 있다.
const KOREAN_TAG_MAP: Readonly<Record<string, string>> = {
  // 효과음 — 자연·환경 (말소리 밑에 배경으로 루프)
  빗소리: 'rain sounds',
  천둥: 'thunder',
  바람소리: 'wind sounds',
  파도소리: 'ocean waves',
  새소리: 'birds chirping',
  귀뚜라미: 'crickets',
  모닥불: 'campfire',
  시냇물: 'stream',
  도시소음: 'city ambience',
  공포: 'horror ambience',
  시계소리: 'clock ticking',
  심장소리: 'heartbeat',
  드럼: 'drum roll',
  두구두구: 'drum roll',
  박수: 'applause',
  발소리: 'footsteps',
  폭죽: 'fireworks',
  기차: 'train',
  헬리콥터: 'helicopter',
  // 효과음 — 단발 (시작에 한 번 재생)
  폭발: 'explosion',
  총소리: 'gunshot',
  문소리: 'door slams',
  팡파레: 'fanfare',
  실패음: 'sad trombone',
  두둥: 'dramatic sting',
  마법: 'magic sparkle',
  레이저: 'laser',
  동전: 'coin',
  종소리: 'bell',
  사이렌: 'siren',
  경보: 'alarm',
  늑대: 'wolf howl',
  고양이: 'cat meow',
  강아지: 'dog bark',
  닭: 'rooster',
  비명: 'scream',
  방귀: 'fart',
  삐걱: 'creaking door',
  까마귀: 'crow',
  경적: 'car horn',
  // 감정·연기
  웃음: 'laughs',
  속삭임: 'whispers',
  한숨: 'sighs',
  울음: 'crying',
  신남: 'excited',
  화남: 'angry',
  슬픔: 'sad',
  노래: 'singing',
  하품: 'yawns',
  헛기침: 'clears throat',
}

// 사용자 이름을 음성으로 읽기 좋게 정제한다. 닉네임에 [태그]나 이모지를
// 넣어 연기 지시를 주입하는 장난을 막기 위해 괄호류·픽토그램을 제거한다.
function sanitizeName(rawName: string): string {
  return rawName
    .replace(/[[\]<>{}]/gu, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 20)
}

// 통화방 입장/퇴장 안내 멘트를 만든다.
export function buildPresenceAnnouncement(
  rawName: string,
  isBot: boolean,
  joined: boolean
): string {
  if (isBot) {
    return joined ? '[robotic] 봇이 참여했어요.' : '[robotic] 봇이 나갔어요.'
  }

  const name = sanitizeName(rawName)
  const safeName = name.length > 0 ? name : '누군가'

  return joined
    ? `[happy] ${safeName}님이 통화방에 참여했어요!`
    : `[sad] ${safeName}님이 통화방에서 떠났어요..`
}

// 스티커가 붙은 메시지에서 읽어줄 문구를 만든다. 스티커만 있는 메시지는
// 본문이 비어 있어 그냥 두면 아무것도 읽히지 않으므로 이름을 읽어준다.
// 예: 스티커 "웃음" → "웃음 스티커"
export function buildStickerReadout(names: readonly string[]): string | null {
  const cleaned = names.map(sanitizeName).filter((n) => n.length > 0)
  if (cleaned.length === 0) return null
  return `${cleaned.join(', ')} 스티커`
}

// 음성으로 읽지 않아야 할 내용 판정. 검열 모듈의 필터를 재사용해
// 19금(성적) 내용과 high 등급 욕설(씨발·개새끼·니애미 등 쌍욕·비하)을 막는다.
// medium(좆·존나 등 단일 욕설)은 채팅 분위기상 그대로 읽는다.
export function isCensoredText(content: string): boolean {
  if (checkNsfwWords(content) !== null) return true
  const banned = checkBannedWords(content)
  return banned !== null && banned.severity === 'high'
}

// 조합되지 않은 낱개 자모(호환 자모)의 읽는 이름.
// ㅁㄴㄴㅇㄹ 같은 키보드 뭉개기를 "미음 니은 니은 이응 리을"로 풀어 읽는다.
const JAMO_NAMES: Readonly<Record<string, string>> = {
  // 자음
  ㄱ: '기역',
  ㄲ: '쌍기역',
  ㄳ: '기역시옷',
  ㄴ: '니은',
  ㄵ: '니은지읒',
  ㄶ: '니은히읗',
  ㄷ: '디귿',
  ㄸ: '쌍디귿',
  ㄹ: '리을',
  ㄺ: '리을기역',
  ㄻ: '리을미음',
  ㄼ: '리을비읍',
  ㄽ: '리을시옷',
  ㄾ: '리을티읕',
  ㄿ: '리을피읖',
  ㅀ: '리을히읗',
  ㅁ: '미음',
  ㅂ: '비읍',
  ㅃ: '쌍비읍',
  ㅄ: '비읍시옷',
  ㅅ: '시옷',
  ㅆ: '쌍시옷',
  ㅇ: '이응',
  ㅈ: '지읒',
  ㅉ: '쌍지읒',
  ㅊ: '치읓',
  ㅋ: '키읔',
  ㅌ: '티읕',
  ㅍ: '피읖',
  ㅎ: '히읗',
  // 모음 — 이름이 곧 그 소리
  ㅏ: '아',
  ㅐ: '애',
  ㅑ: '야',
  ㅒ: '얘',
  ㅓ: '어',
  ㅔ: '에',
  ㅕ: '여',
  ㅖ: '예',
  ㅗ: '오',
  ㅘ: '와',
  ㅙ: '왜',
  ㅚ: '외',
  ㅛ: '요',
  ㅜ: '우',
  ㅝ: '워',
  ㅞ: '웨',
  ㅟ: '위',
  ㅠ: '유',
  ㅡ: '으',
  ㅢ: '의',
  ㅣ: '이',
}

export interface TtsPrepareOptions {
  // 멘션 ID를 표시 이름으로 변환한다. undefined면 이름을 알 수 없는 것으로 본다.
  resolveMention?: (id: string) => string | undefined
}

export function prepareTtsText(
  raw: string,
  options?: TtsPrepareOptions
): string | null {
  let text = raw

  // 코드블록 / 인라인 코드
  text = text.replace(/```[\s\S]*?```/gu, ' ')
  text = text.replace(/`[^`]*`/gu, ' ')

  // 스포일러 ||내용|| — 채팅에선 가려져 있으므로 내용을 읽으면 안 된다.
  // URL 처리보다 먼저 실행해 스포일러 안의 링크도 함께 가린다.
  text = text.replace(/\|\|[\s\S]+?\|\|/gu, ' 스포일러 ')

  // URL
  text = text.replace(/https?:\/\/\S+/giu, ' 링크 ')

  // 커스텀 이모지 <:name:id> / <a:name:id> → name
  text = text.replace(/<a?:(\w+):\d+>/gu, ' $1 ')

  // 유니코드 이모지 제거 (국기 🇯🇵, 픽토그램 😀 등) — 읽으면 어색하다
  text = text.replace(/\u{FE0F}/gu, '')
  text = text.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ' ')
  text = text.replace(/\p{Extended_Pictographic}/gu, ' ')

  // 멘션류 — 유저 멘션은 표시 이름을 넣어 "○○님 멘션"으로 읽는다.
  // 이름을 알 수 없으면(탈퇴 등) 그냥 "님 멘션"으로 읽는다.
  text = text.replace(/<@!?(\d+)>/gu, (_match, id: string) => {
    const resolved = options?.resolveMention?.(id)
    const name = resolved !== undefined ? sanitizeName(resolved) : ''
    return name.length > 0 ? ` ${name}님 멘션 ` : ' 님 멘션 '
  })
  text = text.replace(/<@&\d+>/gu, ' 역할 ')
  text = text.replace(/<#\d+>/gu, ' 채널 ')

  text = normalizeKoreanHours(text)
  text = normalizeKoreanWonAmounts(text)

  // 마크다운 강조 기호
  text = text.replace(/[*_~>#|]/gu, ' ')

  // 한글 태그 → ElevenLabs v3 태그 번역 (효과음·감정을 한글로 쓸 수 있게)
  // 예: [빗소리] → [rain sounds]. 목록에 없는 태그는 입력 그대로 전달.
  text = text.replace(/\[([^\]]+)\]/gu, (match, inner: string) => {
    const mapped = KOREAN_TAG_MAP[inner.trim()]
    return mapped !== undefined ? `[${mapped}]` : match
  })

  // 감정 표현 → ElevenLabs v3 오디오 태그 (순서 중요: 긴 패턴 먼저)
  // 태그는 발음되지 않고 연기 지시로 해석된다.
  // 놀리는 말투: 단독/문장 끝 "저런"만 (뒤에 명사가 오는 지시어 "저런 거"는 제외)
  // 매번 놀리면 약오르니 확률적으로만, 늘임 없이 가볍게.
  text = text.replace(/(?:^|(?<=\s))저런(?=\s*(?:[.,!?~…]|ㅋ|$))/gu, (m) =>
    Math.random() < 0.5 ? ' [mischievously] 저런 ' : m
  )
  text = text.replace(/(?:아쉽네요|안타깝네요|어쩔 수 없네요)/gu, (m) =>
    Math.random() < 0.4 ? ` [sarcastic] ${m} ` : m
  )
  // 자모 채팅 축약어 → 읽을 수 있는 말 (긴 패턴 먼저)
  // ㅋ이 포함된 축약어(ㅇㅋ, ㅊㅋ)는 아래 웃음 태그가 ㅋ을 먹기 전에
  // 처리해야 하므로 웃음 변환보다 먼저 실행한다.
  text = text.replace(/ㅇㄱㄹㅇ/gu, ' 이거 리얼 ')
  text = text.replace(/ㄹㅇ/gu, ' 리얼 ')
  text = text.replace(/ㅇㄱ/gu, ' 이거 ')
  text = text.replace(/ㅈㅉ/gu, ' 진짜 ')
  text = text.replace(/ㅇㅈ+/gu, ' 인정 ')
  text = text.replace(/ㅇㅇ+(?=[?!])/gu, ' 에요 ')
  text = text.replace(/ㅇㅇ+/gu, ' 응응 ')
  text = text.replace(/ㅊㅋㅊㅋ/gu, ' 추카추카 ')
  text = text.replace(/ㅊㅋ/gu, ' 추카 ')
  text = text.replace(/ㅇㅋ/gu, ' 오케이 ')
  text = text.replace(/ㅅㄱ/gu, ' 수고 ')
  text = text.replace(/ㄱㅅ/gu, ' 감사 ')
  text = text.replace(/ㅎㅇ/gu, ' 하이 ')
  text = text.replace(/ㅂㅇ/gu, ' 바이 ')
  text = text.replace(/(?:ㅂㅂ|ㅃㅃ)/gu, ' 바이바이 ')
  text = text.replace(/ㅌㅌ/gu, ' 튀튀 ')
  // ㅈㅈ = GG (항복 선언). "지지"로 쓰면 유아어처럼 들려서 영문 GG로 읽힌다.
  text = text.replace(/ㅈㅈ+/gu, ' GG ')
  text = text.replace(/ㄱㄱ+/gu, ' 고고 ')
  text = text.replace(/ㄴㄴ+/gu, ' 노노 ')
  text = text.replace(/ㄷㄷ+/gu, ' 덜덜 ')
  text = text.replace(/ㄱㅊ/gu, ' 괜찮 ')
  text = text.replace(/ㄱㄷ/gu, ' 기달 ')
  text = text.replace(/ㅇㄷ/gu, ' 어디 ')
  text = text.replace(/ㅎㄹ/gu, ' 헐 ')

  text = text.replace(/ㅋ{4,}/gu, ' [laughs harder] ')
  text = text.replace(/ㅋ{2,3}/gu, ' [laughs] 크크 ')
  text = text.replace(/ㅋ/gu, ' [chuckles] ')
  text = text.replace(/ㅎ{2,}/gu, ' [chuckles] ')
  text = text.replace(/(?:흑흑|엉엉|잉잉)/gu, ' [crying] 엉엉 ')
  text = text.replace(/[ㅠㅜ]{2,}/gu, ' [crying] ')
  text = text.replace(/(?:에휴|어휴|에효)/gu, ' [sighs] 에휴 ')
  text = text.replace(/(?:^|\s)[하휴]\.{2,}/gu, ' [sighs] ')

  // 느낌표 3연타 이상 → 신나는 톤으로 연기 (!!는 일상 강조라 제외)
  if (/!{3,}/u.test(text)) {
    text = `[excited] ${text.replace(/!{2,}/gu, '!')}`
  }

  // 변환되지 않고 남은 자모 조각(ㅅㅂ, ㅇㅅㅇ, 낱자 등)은 그대로는
  // 발음할 수 없으므로 자음/모음 이름으로 풀어 읽는다. (ㅁㄴㄴㅇㄹ → 미음 니은 …)
  text = text.replace(/[ㄱ-ㅎㅏ-ㅣ]/gu, (jamo: string) => {
    const name = JAMO_NAMES[jamo]
    return name !== undefined ? ` ${name} ` : ' '
  })

  // 같은 태그 연속 중복 제거
  text = text.replace(
    /(\[(?:laughs harder|laughs|chuckles|crying|sighs|excited|mischievously|sarcastic)\]\s*)\1+/gu,
    '$1'
  )

  // 공백 정리
  text = text.replace(/\s+/gu, ' ').trim()

  if (text.length === 0) return null

  if (text.length > MAX_TTS_LENGTH) {
    // 절삭 지점에서 잘린 오디오 태그([laugh...) 조각 제거
    const sliced = text.slice(0, MAX_TTS_LENGTH).replace(/\[[^\]]*$/u, '')
    text = `${sliced}. 알림이에요! 여기까지는 너무 길어서 생략했어요!`
  }

  return text
}
