export type IntroInfo = {
  readonly description: string
  readonly fields: readonly { name: string; value: string }[]
  readonly title: string
}

export const INTRO_INFO: IntroInfo = {
  description:
    '한국 Discord 서버 운영을 돕는 봇이에요. 음악 재생, 게임, 경제, 서버 관리 기능을 제공하고, @멘션으로 AI와 대화할 수 있어요.',
  fields: [
    { name: '음악', value: '`/음악 재생`, `/음악 스킵`, `/음악 정지`' },
    { name: '게임', value: '`/게임 동전`, `/게임 주사위`, `/게임 가위바위보`' },
    { name: '경제', value: '`/경제 잔액`, `/경제 출석`, `/경제 송금`' },
    { name: '서버 관리', value: '`/서버 채널`, `/서버 카테고리`, `/서버 권한점검`' },
    { name: 'AI 대화', value: '이 봇을 @멘션하고 질문해 보세요.' },
  ],
  title: 'FullMoon 봇이에요!',
}

type MentionInfo = {
  readonly prompt: string
}

export function detectMentionPrompt(botId: string, content: string): MentionInfo | undefined {
  return detectMention(botId, content)
}

function detectMention(botId: string, content: string): MentionInfo | undefined {
  const mentionPattern = new RegExp(`<@!?${escapeRegExp(botId)}>`, 'u')
  const match = content.match(mentionPattern)
  if (match === null || match.index === undefined) {
    return undefined
  }

  const remaining = content.slice(match.index + match[0].length).trim()
  return { prompt: remaining }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
