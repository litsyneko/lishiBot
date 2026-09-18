import { type FilterResult, moderationConfig } from './moderationConfig'

type SpamMessageEntry = {
  readonly at: number
  readonly channelId: string
  readonly content: string
  readonly messageId: string
}

type DuplicateEntry = {
  readonly at: number
  readonly content: string
}

type UserSpamState = {
  readonly messages: readonly SpamMessageEntry[]
  readonly duplicates: readonly DuplicateEntry[]
  timedOutUntil: number
}

export type SpamMessageInput = {
  readonly channelId: string
  readonly content: string
  readonly guildId: string
  readonly messageId: string
  readonly userId: string
}

export type RecentSpamMessage = {
  readonly channelId: string
  readonly messageId: string
}

export type RecentSpamLookup = {
  readonly guildId: string
  readonly now?: number
  readonly userId: string
  readonly windowMs: number
}

const spamStates = new Map<string, UserSpamState>()

function key(guildId: string, userId: string): string {
  return `${guildId}:${userId}`
}

function purgeOldEntries<Entry extends { readonly at: number }>(
  entries: readonly Entry[],
  windowMs: number,
  now: number
): readonly Entry[] {
  return entries.filter((entry) => now - entry.at < windowMs)
}

export function isCurrentlyTimedOut(
  guildId: string,
  userId: string,
  now: number = Date.now()
): boolean {
  const state = spamStates.get(key(guildId, userId))
  return state !== undefined && now < state.timedOutUntil
}

export function markTimedOut(
  guildId: string,
  userId: string,
  durationMs: number,
  now: number = Date.now()
): void {
  const k = key(guildId, userId)
  const current = spamStates.get(k)
  spamStates.set(k, {
    duplicates: [],
    messages: [],
    timedOutUntil: now + durationMs,
  })
  if (current === undefined) return
}

export function recordMessage(input: SpamMessageInput): FilterResult | null {
  const k = key(input.guildId, input.userId)
  const now = Date.now()
  const config = moderationConfig.spamConfig

  const current = spamStates.get(k) ?? {
    duplicates: [],
    messages: [],
    timedOutUntil: 0,
  }

  if (now < current.timedOutUntil) {
    return {
      filter: 'spam',
      matched: true,
      reason: '타임아웃 중 메시지 전송',
      severity: 'high',
    }
  }

  const recentMessages = purgeOldEntries(current.messages, config.windowMs, now)
  const recentDuplicates = purgeOldEntries(
    current.duplicates,
    config.duplicateWindowMs,
    now
  )

  const updatedMessages = [
    ...recentMessages,
    {
      at: now,
      channelId: input.channelId,
      content: input.content,
      messageId: input.messageId,
    },
  ]
  const updatedDuplicates = [
    ...recentDuplicates,
    { at: now, content: input.content },
  ]

  spamStates.set(k, {
    duplicates: updatedDuplicates,
    messages: updatedMessages,
    timedOutUntil: current.timedOutUntil,
  })

  if (updatedMessages.length > config.maxMessages) {
    return {
      filter: 'spam',
      matched: true,
      reason: `메시지 도배 (${updatedMessages.length}회 / ${
        config.windowMs / 1000
      }초)`,
      severity: 'medium',
    }
  }

  const duplicateCount = updatedDuplicates.filter(
    (entry) => entry.content === input.content
  ).length
  if (duplicateCount > config.maxDuplicates) {
    return {
      filter: 'spam',
      matched: true,
      reason: `동일 메시지 반복 (${duplicateCount}회)`,
      severity: 'medium',
    }
  }

  const mentionCount = (input.content.match(/<@[&!]?(\d+)>/gu) ?? []).length
  if (mentionCount > config.maxMentions) {
    return {
      filter: 'spam',
      matched: true,
      reason: `과도한 멘션 (${mentionCount}회)`,
      severity: 'medium',
    }
  }

  const lineCount = input.content.split('\n').length
  if (lineCount > config.maxLinesCap) {
    return {
      filter: 'spam',
      matched: true,
      reason: `과도한 줄 수 (${lineCount}줄)`,
      severity: 'low',
    }
  }

  return null
}

export function getRecentMessageIds(
  lookup: RecentSpamLookup
): readonly RecentSpamMessage[] {
  const state = spamStates.get(key(lookup.guildId, lookup.userId))
  if (state === undefined) return []

  const now = lookup.now ?? Date.now()
  return purgeOldEntries(state.messages, lookup.windowMs, now).map((entry) => ({
    channelId: entry.channelId,
    messageId: entry.messageId,
  }))
}

export function clearUserSpamState(guildId: string, userId: string): void {
  spamStates.delete(key(guildId, userId))
}

export function resetAllSpamStates(): void {
  spamStates.clear()
}
