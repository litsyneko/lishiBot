import {
  type FilterResult,
  type ModerationCategory,
  type ModerationFilterKind,
  moderationConfig,
} from './moderationConfig'

// 공백(\s)은 제거하지 않는다. 공백을 없애면 인접한 두 단어가 붙어
// 새 금지어가 만들어져(예: "존 나이스" → "존나이스") 오탐이 발생한다.
const FILLER_CHARS = /[._\-*/+#@$%^&(){}|<>!,?~`'"=;:0-9]/gu
const JAMO_FILLER = /[ㄱ-ㅎㅏ-ㅣ]/u

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(FILLER_CHARS, '')
    .split('')
    .filter((char) => !JAMO_FILLER.test(char))
    .join('')
}

function stripUrls(text: string): string {
  return text.replace(moderationConfig.urlPattern, ' ')
}

function checkWordList(
  content: string,
  list: readonly {
    readonly label: string
    readonly pattern: RegExp
    readonly severity: 'high' | 'low' | 'medium'
  }[],
  kind: ModerationFilterKind = 'bannedWord'
): FilterResult | null {
  const normalized = normalizeText(content)
  for (const entry of list) {
    if (entry.pattern.test(content) || entry.pattern.test(normalized)) {
      return {
        filter: kind,
        matched: true,
        reason: entry.label,
        severity: entry.severity,
      }
    }
  }
  return null
}

export function checkBannedWords(content: string): FilterResult | null {
  return checkWordList(content, moderationConfig.bannedWords)
}

export function checkPoliticalWords(content: string): FilterResult | null {
  return checkWordList(content, moderationConfig.politicalWords)
}

export function checkNsfwWords(content: string): FilterResult | null {
  return checkWordList(stripUrls(content), moderationConfig.nsfwWords, 'nsfw')
}

export function checkCryptoSpam(content: string): FilterResult | null {
  return checkWordList(
    content,
    moderationConfig.cryptoSpamPatterns,
    'cryptoSpam'
  )
}

export function checkPersonalInfo(content: string): FilterResult | null {
  return checkWordList(
    content,
    moderationConfig.personalInfoPatterns,
    'personalInfo'
  )
}

export function checkInviteLink(content: string): FilterResult | null {
  const match = content.match(moderationConfig.invitePattern)
  if (match === null) return null

  return {
    filter: 'inviteLink',
    matched: true,
    reason: '디스코드 초대 링크',
    severity: 'high',
  }
}

export function checkExternalUrl(content: string): FilterResult | null {
  const matches = content.matchAll(moderationConfig.urlPattern)
  for (const match of matches) {
    const url = match[1]
    if (url !== undefined && !moderationConfig.isWhitelistedUrl(url)) {
      return {
        filter: 'externalUrl',
        matched: true,
        reason: `외부 링크 (${url})`,
        severity: 'low',
      }
    }
  }
  return null
}

export function checkAllContentFilters(
  content: string,
  isCategoryEnabled: (category: ModerationCategory) => boolean = () => true
): FilterResult | null {
  const checks: readonly (readonly [
    ModerationCategory,
    () => FilterResult | null
  ])[] = [
    ['personalInfo', () => checkPersonalInfo(content)],
    ['nsfw', () => checkNsfwWords(content)],
    ['crypto', () => checkCryptoSpam(content)],
    ['invite', () => checkInviteLink(content)],
    ['political', () => checkPoliticalWords(content)],
    ['profanity', () => checkBannedWords(content)],
    ['externalUrl', () => checkExternalUrl(content)],
  ]

  for (const [category, check] of checks) {
    if (!isCategoryEnabled(category)) continue
    const result = check()
    if (result !== null) return result
  }
  return null
}
