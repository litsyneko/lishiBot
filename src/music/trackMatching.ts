import { logger } from '../utils/logger'

/**
 * 스포티파이 트랙 ↔ 유튜브 뮤직 카드 후보 매칭 정책 (v2).
 * - 스포티파이 원본 음원 재생은 더 이상 사용하지 않고, 유튜브 뮤직에서
 *   제목/아티스트/길이가 똑같거나 비슷한 트랙을 골라 대신 재생한다.
 * - 스코어가 높으면(STRONG/GOOD) 그 트랙, 점수는 낮지만 신호 하나라 확실하면
 *   최고 후보(rescue), 어렴풋한 것조차 없으면 skip(none)한다.
 */

export type SpotifyCandidate = {
  title: string
  author: string
  durationMs?: number
}

export type YtCandidate = {
  title: string
  author?: string
  durationMs?: number
}

/** 제목/검색어에서 제거할 무의미 토큰 */
const TITLE_NOISE_TOKENS = new Set([
  'official',
  'video',
  'audio',
  'mv',
  'm/v',
  'mnet',
  'music',
  'visualizer',
  'lyrics',
  'lyric',
  '가사',
  'color',
  'coded',
  'colorcoded',
  'han',
  'rom',
  'eng',
  'sub',
  'subs',
  'subtitles',
  'subtítulos',
  '4k',
  'hd',
  'uhd',
  'promo',
  'full',
  'ver',
  'version',
  'w bonuses',
])

/** 리믹스/라이브/커버 변형 키워드 — 스포티파이 원곡과 다를 가능성이 높아 감점 */
const MODIFIER_KEYWORDS = [
  'nightcore',
  'remix',
  're-mix',
  'rearranged',
  'rearrange',
  'live',
  'acoustic',
  'cover',
  'inst',
  'instrumental',
  'karaoke',
  'sped',
  'slowed',
  'reverb',
  'mashup',
  '8d',
  '라이브',
  '리믹스',
  '커버',
  '가창',
  '어쿠스틱',
  '인스트루멘탈',
  '스피드업',
  '레이트슬로우',
]

const STRONG_SCORE = 82
const GOOD_SCORE = 58
/** duration 비교 허용 오차 (밀리초) */
const DURATION_TOLERANCE_MS = 1500
/** duration 페널티 최대치 */
const DURATION_MAX_PENALTY = 22

const MODIFIER_CHARS = /[^\p{L}\p{N}\s]/gu

/**artist-side noise words that do not carry identity signal */
const ARTIST_NOISE_TOKENS = new Set([
  'official',
  'topic',
  'music',
  'the',
  'a',
  'an',
  'and',
  'records',
  'recordings',
  'entertainment',
  'studio',
  'labs',
  'lab',
  'tv',
  'official',
  'official',
  'official',
])

/** 개별 변형 라벨 추출 (정규화된 문자열 중에서) */
function detectModifiers(normalizedCandidate: string): Set<string> {
  const found = new Set<string>()
  for (const kw of MODIFIER_KEYWORDS) {
    if (normalizedCandidate.includes(kw)) found.add(kw)
  }
  return found
}

export function normalizeTrackTitle(value: string): string {
  let s = value.toLowerCase().normalize('NFKC')
  // 괄호/대괄호 보조 정보 제거
  s = s.replace(/[\(\[\{［«][^)\]\}］»]*[\)\]\}］»]/g, ' ')
  s = s.replace(MODIFIER_CHARS, ' ')
  // feat/featuring/with 키워드는 노이즈 토큰으로 대체 (실제 이름은 유지)
  s = s.replace(/\b(feat|ft|featuring|with|w\/)\b\.?/g, ' ')

  const tokens = s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t) => !TITLE_NOISE_TOKENS.has(t))
  return tokens.join(' ').trim()
}

function tokenizeWords(value: string): string[] {
  return normalizeTrackTitle(value)
    .split(' ')
    .filter((t) => t.length > 0)
}

/** 문자 bigram Dice 유사도 — CJK/한글 표기변화에 강하다 */
export function diceBigrams(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  if (a === b) return 1
  const grams = (s: string): Set<string> => {
    const arr: string[] = []
    if (s.length === 1) arr.push(s)
    for (let i = 0; i < s.length - 1; i++) arr.push(s.slice(i, i + 2))
    return new Set(arr)
  }
  const A = grams(a)
  const B = grams(b)
  let inter = 0
  for (const g of A) {
    if (B.has(g)) inter++
  }
  return (2 * inter) / (A.size + B.size)
}

/** Levenshtein 비율 유사도 0..1 */
export function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  let prev = new Array(b.length + 1).fill(0).map((_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      )
    }
    prev = cur
  }
  const maxLen = Math.max(a.length, b.length)
  return (maxLen - prev[b.length]) / maxLen
}

function tokenDice(a: string, b: string): number {
  const at = new Set(a.split(' ').filter(Boolean))
  const bt = new Set(b.split(' ').filter(Boolean))
  if (at.size === 0 || bt.size === 0) return 0
  let inter = 0
  for (const t of at) {
    if (bt.has(t)) inter++
  }
  return (2 * inter) / (at.size + bt.size)
}

function jaccardTokens(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  const at = new Set(a.split(' '))
  const bt = new Set(b.split(' '))
  let inter = 0
  for (const t of at) {
    if (bt.has(t)) inter++
  }
  const union = new Set([...at, ...bt]).size
  return union === 0 ? 0 : inter / union
}

/** 변형 키워드(remix/nightcore/live/cover 등)를 제거한 코어 토큰열.
 *  'X - Mwk Remix' 처럼 리믹서가 제목에 붙는 스포티파이 표기는 아티스트 토큰을
 *  제거해 'X (feat. Y) [Mwk Remix]'와 동일한 코어로 비교한다. */
function coreTokens(normalized: string, excludeTokens?: string[]): string {
  const exclude = new Set(excludeTokens ?? [])
  const out: string[] = []
  const tokens = normalized.split(' ').filter((t) => t.length > 0)
  for (let i = 0; i < tokens.length; i++) {
    if (MODIFIER_KEYWORDS.includes(tokens[i])) {
      i += 1 // modifier 뒤의 한 토큰(리믹서)도 스킵
      continue
    }
    if (exclude.has(tokens[i])) continue
    out.push(tokens[i])
  }
  return out.join(' ').trim()
}

/** 제목 유사도 0..1 — Dice(토큰)+Jaccard+Levenshtein+Bigram 가중 합 */
export function titleSimilarity(
  spotifyTitle: string,
  ytTitle: string,
  spotifyAuthor?: string
): number {
  const sNorm = normalizeTrackTitle(spotifyTitle)
  const yNorm = normalizeTrackTitle(ytTitle)
  if (sNorm.length === 0 || yNorm.length === 0) return 0
  // 완전 동일 or 부분 관계 강폭
  if (sNorm === yNorm) return 1
  const dice = tokenDice(sNorm, yNorm)
  const jac = jaccardTokens(sNorm, yNorm)
  const lev = levenshteinRatio(sNorm, yNorm)
  const big = diceBigrams(sNorm, yNorm)
  // 포함 관계는 Dice보다 유리하므로 보너스. 단, 1토큰 제목은 부분 포함만으로
  // 0.6대 유사도가 되어 오탐('progress → "Progress" — IDLES')이 빈번하므로
  // 양쪽 2토큰 이상일 때만 부여한다.
  const sTokens = sNorm.split(' ').length
  const yTokens = yNorm.split(' ').length
  const containmentBonus =
    sTokens >= 2 && yTokens >= 2
      ? (yNorm.includes(sNorm) ? 0.08 : 0) + (sNorm.includes(yNorm) ? 0.08 : 0)
      : 0
  const combined =
    0.38 * dice + 0.2 * jac + 0.24 * lev + 0.18 * big + containmentBonus

  // 리믹스 어노테이션이 제목과 뒤섞인 형태 ('X - Mwk Remix' vs 'X [Mwk Remix]')를
  // 변형 키워드+스포티파이 아티스트 토큰 제거 후 비교한 코어 유사도로 보정한다.
  let coreSim = 0
  if (sNorm !== undefined && yNorm !== undefined) {
    const sExcluded = spotifyAuthor
      ? normalizeTrackTitle(spotifyAuthor).split(' ').filter(Boolean)
      : []
    const sCore = coreTokens(sNorm, sExcluded)
    const yCore = coreTokens(yNorm, sExcluded)
    if (sCore.length > 0 && yCore.length > 0) {
      coreSim =
        sCore === yCore
          ? 0.95
          : 0.9 * Math.max(tokenDice(sCore, yCore), levenshteinRatio(sCore, yCore))
      // 코어에 제목과 아였 길이가 유의미하게 짧으면(공백 등) 강폭하지 않는다
      if (sCore.length < 3 || yCore.length < 3) coreSim *= 0.85
    }
  }
  return Math.max(0, Math.min(1, Math.max(combined, coreSim)))
}

/** 스포티파이 아티스트 지표 토큰 (feat. 제거, 다중 아티스트 분해, 노이즈 제거) */
function primaryArtistTokens(value: string): string[][] {
  const parts = value
    .split(/[,;&\\/|]|(?:\s+&\s+)|(?:\s+\bfeat\b\.\s*)|(?:\s+\bft\b\.\s*)|(?:\s+\bwith\b\s+)/i)
    .map((a) => a.trim())
    .filter((a) => a.length > 0)
  return parts.map((artist) =>
    tokenizeWords(artist).filter(
      (t) => t.length > 0 && !ARTIST_NOISE_TOKENS.has(t)
    )
  )
}

/** 스포티파이 아티스트 커버리지 0..1 — YT author+title 합산 영역에서 토큰 포함 비율 */
export function artistCoverage(
  spotifyAuthor: string,
  ytAuthor: string | undefined,
  ytTitle: string
): number {
  const artistGroups = primaryArtistTokens(spotifyAuthor)
  if (artistGroups.length === 0) return 0
  // 커버 확인 대상: YT author + YT title 합산 (아티스트가 제목에 등장하는 것도 흔함)
  const haystack = normalizeTrackTitle(
    `${ytAuthor ?? ''} ${ytTitle}`
  )
  if (haystack.length === 0) return 0
  const hayTokens = new Set(haystack.split(' '))
  const hayText = ` ${haystack} `
  let covered = 0
  for (const tokens of artistGroups) {
    if (tokens.length === 0) {
      covered += 1
      continue
    }
    // 토큰 단위 일치 또는 부분 포함
    const matched = tokens.filter(
      (t) => hayTokens.has(t) || hayText.includes(` ${t} `)
    ).length
    const ratio = matched / tokens.length
    // 유의미한 커버 판단 — 최소 절반 이상이어야 커버로 인정
    if (ratio >= 0.5) covered += 1
  }
  return covered / artistGroups.length
}

/** 스포티파이 원작 지표에 YT가 없어야 하는 modifier 페널티 */
export function variationPenalty(
  spotifyTitle: string,
  spotifyAuthor: string,
  ytTitle: string,
  ytAuthor: string | undefined
): number {
  // Spotify 메타데이터의 "진짜" modifiers (title + author)
  const spotifyText = normalizeTrackTitle(`${spotifyTitle} ${spotifyAuthor}`)
  const ytText = normalizeTrackTitle(`${ytTitle} ${ytAuthor ?? ''}`)
  const spMods = detectModifiers(spotifyText)
  const ytMods = detectModifiers(ytText)

  const extraInYt = [...ytMods].filter((m) => !spMods.has(m))
  const missingInYt = [...spMods].filter((m) => !ytMods.has(m))

  // 아티스트 자체가 modifier 채널인 경우(nightcore 등) 예외
  const spAuthorTokens = new Set(
    normalizeTrackTitle(spotifyAuthor).split(' ')
  )
  const ytAuthorTokens = new Set(
    normalizeTrackTitle(`${ytAuthor ?? ''}`).split(' ')
  )
  const finalExtra = extraInYt.filter((m) => {
    if (m === 'nightcore') {
      if (spAuthorTokens.has('nightcore') || ytAuthorTokens.has('nightcore')) {
        return false
      }
    }
    return true
  })
  const finalMissing = missingInYt.filter((m) => {
    if (m === 'nightcore') {
      if (spAuthorTokens.has('nightcore') || ytAuthorTokens.has('nightcore')) {
        return false
      }
    }
    return true
  })

  return Math.min(22, finalExtra.length * 6 + finalMissing.length * 5)
}

function durationPenalty(
  spotifyDurationMs: number | undefined,
  ytDurationMs: number | undefined
): number {
  if (
    spotifyDurationMs === undefined ||
    ytDurationMs === undefined ||
    spotifyDurationMs <= 0 ||
    ytDurationMs <= 0
  ) {
    return 0
  }
  const diff = Math.abs(spotifyDurationMs - ytDurationMs)
  if (diff <= DURATION_TOLERANCE_MS) return 0
  if (diff <= 5_000) return 2
  if (diff <= 15_000) return 4
  if (diff <= 30_000) return 10
  return Math.min(DURATION_MAX_PENALTY, 10 + (diff - 30_000) / 10_000)
}

export type TrackMatchScore = {
  score: number
  titleSimilarity: number
  artistCoverage: number
  durationPenalty: number
  variationPenalty: number
  artistChannelBonus: number
  strong: boolean
}

/** 스포티파이 원곡자가 유튜브 'author 채널'에 직접 올린 경우 — 커버/재업과 다르게
 *  원곡자 본인 채널임을 제목 신호와 분리해 가산하는 보너스. */
function artistChannelBonus(
  spotifyAuthor: string,
  ytAuthor: string | undefined
): number {
  const primaryArtist = (spotifyAuthor.split(/[,;&\\/|]/)[0] ?? '').trim()
  const spNorm = normalizeTrackTitle(primaryArtist)
  const yNorm = normalizeTrackTitle(ytAuthor ?? '')
  if (spNorm.length === 0 || yNorm.length === 0) return 0
  // 채널 이름에 'topic', 'music' 같은 수식어는 자작아티스트 채널로 취급 허용
  const stripChannelSuffix = (value: string): string =>
    value
      .split(' ')
      .filter((t) => t.length > 0 && !ARTIST_NOISE_TOKENS.has(t))
      .join(' ')
      .trim()
  const sp = stripChannelSuffix(spNorm)
  const yt = stripChannelSuffix(yNorm)
  if (sp.length === 0 || yt.length === 0) return 0
  if (yt === sp) return 7
  if (yt.includes(sp)) return 5
  return 0
}

export function scoreYtCandidate(
  spotify: SpotifyCandidate,
  yt: YtCandidate
): TrackMatchScore {
  const titleSim = titleSimilarity(
    spotify.title,
    yt.title,
    spotify.author
  )
  const artistSim = artistCoverage(
    spotify.author,
    yt.author,
    yt.title
  )
  const durPen = durationPenalty(spotify.durationMs, yt.durationMs)
  const varPen = variationPenalty(
    spotify.title,
    spotify.author,
    yt.title,
    yt.author
  )
  const artistPenalty = (1 - artistSim) * 22
  const chanBonus = artistChannelBonus(spotify.author, yt.author)

  const score =
    titleSim * 55 +
    artistSim * 30 +
    chanBonus +
    Math.max(0, 12 - durPen) -
    varPen -
    artistPenalty

  return {
    score,
    titleSimilarity: titleSim,
    artistCoverage: artistSim,
    durationPenalty: durPen,
    variationPenalty: varPen,
    artistChannelBonus: chanBonus,
    strong: score >= STRONG_SCORE,
  }
}

export const TRACK_MATCH_VERDICT = {
  strong: STRONG_SCORE,
  good: GOOD_SCORE,
  toleranceMs: DURATION_TOLERANCE_MS,
} as const

export type MatchOutcome<T extends YtCandidate> = {
  chosen: T | undefined
  outcome: 'strong' | 'good' | 'rescue' | 'fallback' | 'none'
  score: TrackMatchScore | undefined
}

/**
 * 유튜브 뮤직 후보 중 스포티파이 트랙과 가장 가까운 것을 고른다.
 * - STRONG / GOOD: 그대로 사용
 * - 둘 다 미달이지만 명백한 단일 신호(제목 유사도 또는 아티스트 일치)가 강하면
 *   최고 후보로 rescue한다.
 * - 아무런 신호도 없으면 undefined — 상위에서 해당 트랙을 skip한다.
 */
export function pickMatchingYtTrack<T extends YtCandidate>(
  spotify: SpotifyCandidate,
  candidates: readonly T[]
): MatchOutcome<T> {
  if (candidates.length === 0) {
    logger.warn(
      'trackMatching',
      `유튜브 뮤직 후보 없음 (스포티파이: ${spotify.title} — ${spotify.author})`
    )
    return { chosen: undefined, outcome: 'none', score: undefined }
  }

  let best = candidates[0]
  let bestScore: TrackMatchScore | undefined
  for (const candidate of candidates) {
    const score = scoreYtCandidate(spotify, candidate)
    if (bestScore === undefined || score.score > bestScore.score) {
      best = candidate
      bestScore = score
    }
  }

  if (bestScore === undefined) {
    return { chosen: undefined, outcome: 'none', score: undefined }
  }

  if (bestScore.score >= STRONG_SCORE) {
    return { chosen: best, outcome: 'strong', score: bestScore }
  }
  if (bestScore.score >= GOOD_SCORE) {
    return { chosen: best, outcome: 'good', score: bestScore }
  }

  // --- rescue 단계 ---
  // 신호 하나만으로도 강할 경우 최고 후보를 명시적으로 채택한다.
  // 아티스트 신호만으로 rescue하려면 제목이 최소한 어긋나지 않아야 한다(장르 채널 오인 방지).
  // 제목만으로 rescue할 때는 부분 포함('X Music'/'X Me') 오인을 줄이기 위해
  // 문구 길이 스캐일을 요구한다.
  const hasStrongTitle =
    (bestScore.titleSimilarity >= 0.68 &&
      bestScore.durationPenalty <= 5) ||
    (bestScore.titleSimilarity >= 0.55 && bestScore.artistCoverage >= 0.5)
  const hasStrongArtist =
    bestScore.artistCoverage >= 0.95 &&
    bestScore.titleSimilarity >= 0.2 &&
    bestScore.durationPenalty <= 5
  const hasAcceptableIdentity =
    bestScore.titleSimilarity >= 0.42 &&
    bestScore.artistCoverage >= 0.5 &&
    bestScore.durationPenalty <= 4
  if (hasStrongTitle || hasStrongArtist || hasAcceptableIdentity) {
    logger.warn(
      'trackMatching',
      `매칭 rescue (score: ${bestScore.score.toFixed(2)}, 스포티파이: ${
        spotify.title
      } — ${spotify.author}, 유튜브 후보: ${best.title})`
    )
    return { chosen: best, outcome: 'rescue', score: bestScore }
  }

  logger.warn(
    'trackMatching',
    `매칭 스킵 — 후보 부실 (score: ${bestScore.score.toFixed(
      2
    )}, titleSim: ${bestScore.titleSimilarity.toFixed(
      2
    )}, artistSim: ${bestScore.artistCoverage.toFixed(
      2
    )}, 스포티파이: ${spotify.title} — ${spotify.author}, 유튜브 후보: ${
      best.title
    } — ${best.author ?? '알 수 없음'})`
  )
  return { chosen: undefined, outcome: 'none', score: bestScore }
}
