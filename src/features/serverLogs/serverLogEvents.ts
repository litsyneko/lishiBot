import { logger } from '../../utils/logger'
import type { InviteAttribution } from './inviteTracker'
import {
  AuditLogEvent,
  type Collection,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type MessageReaction,
  type PartialGuildMember,
  type PartialMessage,
  type PartialMessageReaction,
  type User,
  type VoiceState,
} from 'discord.js'

const MAX_CONTENT_LENGTH = 1900
const MAX_DIFF_LENGTH = 900
const AUDIT_LOG_MATCH_WINDOW_MS = 5_000
const DELETE_ENTRY_SNAPSHOT_TTL_MS = 15 * 60_000
const NEW_ACCOUNT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000
const MAX_TRANSCRIPT_LENGTH = 100_000

export type MessageDeleteAttribution = {
  readonly deleterId: string | null
  readonly deleterTag: string | null
}

const UNKNOWN_MESSAGE_DELETER: MessageDeleteAttribution = {
  deleterId: null,
  deleterTag: null,
}

export type VoiceActivity = {
  readonly kind:
    | 'join'
    | 'leave'
    | 'move'
    | 'serverMute'
    | 'serverUnmute'
    | 'serverDeafen'
    | 'serverUndeafen'
    | 'streamStart'
    | 'streamStop'
    | 'videoStart'
    | 'videoStop'
  readonly channelId: string | null
  readonly fromChannelId: string | null
  readonly memberTag: string
  readonly memberId: string
}

export type MessageAttachmentInfo = {
  readonly name: string
  readonly url: string
}

export type MessageActivity = {
  readonly kind: 'edit' | 'delete'
  readonly channelId: string
  readonly authorId: string | null
  readonly authorIsBot: boolean | null
  readonly authorTag: string | null
  readonly deleterId: string | null
  readonly deleterTag: string | null
  readonly messageId: string
  readonly oldContent: string | null
  readonly newContent: string | null
  readonly createdTimestamp: number | null
  /** edit: 수정으로 제거된 첨부, delete: 삭제 시점의 첨부 */
  readonly attachments: readonly MessageAttachmentInfo[]
  readonly stickerNames: readonly string[]
  /** 캐시에 없던 메시지라 내용을 확보하지 못한 경우 (빈 내용과 구분용) */
  readonly contentUnavailable: boolean
}

export function detectVoiceActivity(
  oldState: VoiceState,
  newState: VoiceState
): VoiceActivity | null {
  const member = newState.member ?? oldState.member
  const memberId = newState.id
  const memberTag = member?.user.tag ?? memberId

  const oldChannel = oldState.channelId
  const newChannel = newState.channelId

  if (oldChannel === null && newChannel !== null) {
    return {
      channelId: newChannel,
      fromChannelId: null,
      kind: 'join',
      memberId,
      memberTag,
    }
  }

  if (oldChannel !== null && newChannel === null) {
    return {
      channelId: oldChannel,
      fromChannelId: null,
      kind: 'leave',
      memberId,
      memberTag,
    }
  }

  if (oldChannel !== null && newChannel !== null && oldChannel !== newChannel) {
    return {
      channelId: newChannel,
      fromChannelId: oldChannel,
      kind: 'move',
      memberId,
      memberTag,
    }
  }

  // 셀프 음소거/청각 차단은 잡음이 심해 기록하지 않고,
  // 관리자에 의한 서버 음소거/청각 차단만 기록한다.
  if (oldState.serverMute !== newState.serverMute) {
    return {
      channelId: newChannel,
      fromChannelId: null,
      kind: newState.serverMute === true ? 'serverMute' : 'serverUnmute',
      memberId,
      memberTag,
    }
  }

  if (oldState.serverDeaf !== newState.serverDeaf) {
    return {
      channelId: newChannel,
      fromChannelId: null,
      kind: newState.serverDeaf === true ? 'serverDeafen' : 'serverUndeafen',
      memberId,
      memberTag,
    }
  }

  if (newChannel !== null && oldState.streaming !== newState.streaming) {
    return {
      channelId: newChannel,
      fromChannelId: null,
      kind: newState.streaming === true ? 'streamStart' : 'streamStop',
      memberId,
      memberTag,
    }
  }

  if (newChannel !== null && oldState.selfVideo !== newState.selfVideo) {
    return {
      channelId: newChannel,
      fromChannelId: null,
      kind: newState.selfVideo === true ? 'videoStart' : 'videoStop',
      memberId,
      memberTag,
    }
  }

  return null
}

export function describeVoiceActivity(activity: VoiceActivity): string {
  const channel =
    activity.channelId !== null ? `<#${activity.channelId}>` : '알 수 없음'

  switch (activity.kind) {
    case 'join':
      return `${activity.memberTag}님이 ${channel}에 참가했어요.`
    case 'leave':
      return `${activity.memberTag}님이 ${channel}에서 퇴장했어요.`
    case 'move':
      return `${activity.memberTag}님이 ${
        activity.fromChannelId !== null
          ? `<#${activity.fromChannelId}>`
          : '알 수 없음'
      }에서 ${channel}(으)로 이동했어요.`
    case 'serverMute':
      return `${activity.memberTag}님이 ${channel}에서 서버 음소거됐어요. (관리자 조치)`
    case 'serverUnmute':
      return `${activity.memberTag}님의 서버 음소거가 해제됐어요.`
    case 'serverDeafen':
      return `${activity.memberTag}님이 ${channel}에서 서버 청각 차단됐어요. (관리자 조치)`
    case 'serverUndeafen':
      return `${activity.memberTag}님의 서버 청각 차단이 해제됐어요.`
    case 'streamStart':
      return `${activity.memberTag}님이 ${channel}에서 방송(Go Live)을 시작했어요.`
    case 'streamStop':
      return `${activity.memberTag}님이 ${channel}에서 방송을 종료했어요.`
    case 'videoStart':
      return `${activity.memberTag}님이 ${channel}에서 카메라를 켰어요.`
    case 'videoStop':
      return `${activity.memberTag}님이 ${channel}에서 카메라를 껐어요.`
  }
}

export function describeMessageEdit(
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage
): MessageActivity {
  const author = newMessage.author ?? oldMessage.author
  return {
    attachments: collectRemovedAttachments(oldMessage, newMessage),
    authorId: author?.id ?? null,
    authorIsBot: author?.bot ?? null,
    authorTag: author?.tag ?? null,
    channelId: oldMessage.channelId,
    contentUnavailable: oldMessage.partial,
    createdTimestamp: oldMessage.createdTimestamp,
    deleterId: null,
    deleterTag: null,
    kind: 'edit',
    messageId: oldMessage.id,
    newContent: newMessage.content ?? null,
    oldContent: oldMessage.content ?? null,
    stickerNames: [],
  }
}

export function describeMessageDelete(
  message: Message | PartialMessage,
  attribution: MessageDeleteAttribution = UNKNOWN_MESSAGE_DELETER
): MessageActivity {
  return {
    attachments: [...message.attachments.values()].map((attachment) => ({
      name: attachment.name,
      url: attachment.proxyURL ?? attachment.url,
    })),
    authorId: message.author?.id ?? null,
    authorIsBot: message.author?.bot ?? null,
    authorTag: message.author?.tag ?? null,
    channelId: message.channelId,
    contentUnavailable: message.partial,
    createdTimestamp: message.createdTimestamp,
    deleterId: attribution.deleterId,
    deleterTag: attribution.deleterTag,
    kind: 'delete',
    messageId: message.id,
    newContent: null,
    oldContent: message.content ?? null,
    stickerNames: [...message.stickers.values()].map((sticker) => sticker.name),
  }
}

function collectRemovedAttachments(
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage
): readonly MessageAttachmentInfo[] {
  return [...oldMessage.attachments.values()]
    .filter((attachment) => !newMessage.attachments.has(attachment.id))
    .map((attachment) => ({
      name: attachment.name,
      url: attachment.proxyURL ?? attachment.url,
    }))
}

export function hasLoggableMessageEdit(
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage
): boolean {
  // 캐시에 없던(partial) 메시지는 원본 내용(null)을 알 수 없어 내용 비교가
  // 항상 "변경됨"으로 오탐된다. 임베드 언퍼링/고정 같은 내용 없는 업데이트를
  // 걸러내기 위해, 실제 편집(edited_timestamp 갱신)일 때만 기록한다.
  if (oldMessage.partial) {
    return newMessage.editedTimestamp !== null
  }
  if (oldMessage.content !== newMessage.content) return true
  return oldMessage.attachments.size > newMessage.attachments.size
}

export type BulkDeleteAuthorCount = {
  readonly authorId: string
  readonly authorTag: string | null
  readonly count: number
}

export type BulkDeleteDetails = {
  readonly channelId: string
  readonly count: number
  readonly authorCounts: readonly BulkDeleteAuthorCount[]
  readonly uncachedCount: number
  readonly transcript: string | null
}

export function describeBulkDelete(
  channel: GuildBasedChannel,
  messages: Collection<string, Message | PartialMessage>
): BulkDeleteDetails {
  const authorCounts = new Map<
    string,
    { authorTag: string | null; count: number }
  >()
  let uncachedCount = 0

  const sorted = [...messages.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  )

  const transcriptLines: string[] = []
  for (const message of sorted) {
    const author = message.author
    if (author === null || message.partial) {
      uncachedCount += 1
    }
    if (author !== null) {
      const existing = authorCounts.get(author.id)
      if (existing !== undefined) {
        existing.count += 1
      } else {
        authorCounts.set(author.id, { authorTag: author.tag, count: 1 })
      }
    }

    const time = formatKstTimestamp(message.createdTimestamp)
    const label =
      author !== null ? `${author.tag} (${author.id})` : '(알 수 없는 작성자)'
    const content =
      message.content !== null && message.content.length > 0
        ? message.content.replace(/\n/g, '\n    ')
        : message.partial
        ? '(캐시되지 않은 메시지)'
        : '(내용 없음)'
    const attachmentNote =
      message.attachments.size > 0
        ? ` [첨부 ${message.attachments.size}개: ${[
            ...message.attachments.values(),
          ]
            .map((attachment) => attachment.name)
            .join(', ')}]`
        : ''
    transcriptLines.push(`[${time}] ${label}: ${content}${attachmentNote}`)
  }

  let transcript = transcriptLines.join('\n')
  if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
    transcript = transcript.slice(0, MAX_TRANSCRIPT_LENGTH) + '\n…(생략됨)'
  }

  return {
    authorCounts: [...authorCounts.entries()]
      .map(([authorId, value]) => ({
        authorId,
        authorTag: value.authorTag,
        count: value.count,
      }))
      .sort((a, b) => b.count - a.count),
    channelId: channel.id,
    count: messages.size,
    transcript: transcript.length > 0 ? transcript : null,
    uncachedCount,
  }
}

function formatKstTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('sv-SE', {
    timeZone: 'Asia/Seoul',
  })
}

type DeleteEntrySnapshot = {
  count: number
  seenAt: number
}

const deleteEntrySnapshots = new Map<string, Map<string, DeleteEntrySnapshot>>()

const AUDIT_FETCH_COOLDOWN_MS = 1_500
const AUDIT_EVENT_WAIT_MS = 800
const RECENT_DELETE_AUDIT_TTL_MS = 8_000
const lastAuditFetchAt = new Map<string, number>()
const auditFetchWarned = new Set<string>()

type RecentDeleteAudit = {
  readonly at: number
  readonly channelId: string
  readonly targetId: string | null
  readonly executorId: string | null
  readonly executorTag: string | null
}

const recentDeleteAudits = new Map<string, RecentDeleteAudit[]>()

/**
 * guildAuditLogEntryCreate로 도착한 MessageDelete 항목을 잠시 보관한다.
 * 게이트웨이 삭제 이벤트보다 감사 로그 기록이 늦는 레이스를 이 캐시가 흡수하고,
 * 연속(스택) 삭제도 같은 실행자이므로 fetch 없이 귀속할 수 있다.
 */
export function recordDeleteAuditEntry(
  guild: Guild,
  entry: GuildAuditLogsEntry
): void {
  if (entry.action !== AuditLogEvent.MessageDelete) return

  const channelId = extractExtraChannelId(entry.extra)
  if (channelId === null) return

  const now = Date.now()
  const list = (recentDeleteAudits.get(guild.id) ?? []).filter(
    (item) => now - item.at <= RECENT_DELETE_AUDIT_TTL_MS
  )
  list.push({
    at: now,
    channelId,
    executorId: entry.executorId,
    executorTag: entry.executor?.tag ?? null,
    targetId: entry.targetId,
  })
  recentDeleteAudits.set(guild.id, list.slice(-20))

  // fetch 폴백 경로의 카운트 증가 비교가 어긋나지 않도록 스냅샷에도 기록한다.
  guildDeleteSnapshots(guild.id).set(entry.id, {
    count: extractExtraCount(entry.extra) ?? 1,
    seenAt: now,
  })
}

function findRecentDeleteAudit(
  guildId: string,
  channelId: string,
  authorId: string | null
): MessageDeleteAttribution | null {
  const list = recentDeleteAudits.get(guildId)
  if (list === undefined) return null

  const now = Date.now()
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i]
    if (now - item.at > RECENT_DELETE_AUDIT_TTL_MS) continue
    if (item.channelId !== channelId) continue
    if (
      authorId !== null &&
      item.targetId !== null &&
      item.targetId !== authorId
    ) {
      continue
    }
    return { deleterId: item.executorId, deleterTag: item.executorTag }
  }
  return null
}

export async function resolveMessageDeleter(
  guild: Guild,
  message: Message | PartialMessage,
  deletedAtMs: number
): Promise<MessageDeleteAttribution> {
  const authorId = message.author?.id ?? null

  // 1단계: 감사 로그 이벤트 캐시에서 즉시 매칭
  const immediate = findRecentDeleteAudit(guild.id, message.channelId, authorId)
  if (immediate !== null) return immediate

  // 2단계: 감사 로그 기록이 삭제 이벤트보다 늦는 경우가 많아 잠시 대기 후 재확인
  await sleep(AUDIT_EVENT_WAIT_MS)
  const delayed = findRecentDeleteAudit(guild.id, message.channelId, authorId)
  if (delayed !== null) return delayed

  // 3단계: fetch 폴백. 대량 삭제 시 건마다 조회하지 않도록 길드별 쿨다운을 둔다.
  const now = Date.now()
  const lastFetch = lastAuditFetchAt.get(guild.id)
  if (lastFetch !== undefined && now - lastFetch < AUDIT_FETCH_COOLDOWN_MS) {
    return UNKNOWN_MESSAGE_DELETER
  }
  lastAuditFetchAt.set(guild.id, now)

  try {
    const logs = await guild.fetchAuditLogs({
      limit: 10,
      type: AuditLogEvent.MessageDelete,
    })
    const snapshots = guildDeleteSnapshots(guild.id)
    let resolved: MessageDeleteAttribution = UNKNOWN_MESSAGE_DELETER

    for (const entry of logs.entries.values()) {
      const previous = snapshots.get(entry.id)
      const count = entry.extra.count
      snapshots.set(entry.id, { count, seenAt: deletedAtMs })

      if (resolved.deleterId !== null) continue
      if (entry.extra.channel.id !== message.channelId) continue
      if (authorId !== null && entry.targetId !== authorId) continue

      // 디스코드는 같은 관리자의 연속 삭제를 기존 감사 항목에 누적한다.
      // 새로 생성된 항목이거나 누적 카운트가 늘어난 항목만 이번 삭제로 본다.
      const isFreshEntry =
        previous === undefined &&
        Math.abs(entry.createdTimestamp - deletedAtMs) <=
          AUDIT_LOG_MATCH_WINDOW_MS
      const countIncreased = previous !== undefined && count > previous.count
      if (!isFreshEntry && !countIncreased) continue

      resolved = {
        deleterId: entry.executorId,
        deleterTag: entry.executor?.tag ?? null,
      }
    }

    pruneDeleteSnapshots(snapshots, deletedAtMs)
    return resolved
  } catch (err) {
    // 대부분 '감사 로그 보기' 권한 누락. 길드당 한 번만 경고한다.
    if (!auditFetchWarned.has(guild.id)) {
      auditFetchWarned.add(guild.id)
      logger.warn(
        'ServerLog',
        `감사 로그 조회 실패 — 봇에 '감사 로그 보기' 권한이 있는지 확인하세요 (${
          guild.name
        }): ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return UNKNOWN_MESSAGE_DELETER
  }
}

function guildDeleteSnapshots(
  guildId: string
): Map<string, DeleteEntrySnapshot> {
  const existing = deleteEntrySnapshots.get(guildId)
  if (existing !== undefined) return existing
  const created = new Map<string, DeleteEntrySnapshot>()
  deleteEntrySnapshots.set(guildId, created)
  return created
}

function pruneDeleteSnapshots(
  snapshots: Map<string, DeleteEntrySnapshot>,
  nowMs: number
): void {
  for (const [entryId, snapshot] of snapshots) {
    if (nowMs - snapshot.seenAt > DELETE_ENTRY_SNAPSHOT_TTL_MS) {
      snapshots.delete(entryId)
    }
  }
}

function extractExtraChannelId(extra: unknown): string | null {
  if (typeof extra !== 'object' || extra === null) return null
  const channel = (extra as Record<string, unknown>)['channel']
  if (typeof channel !== 'object' || channel === null) return null
  const id = (channel as Record<string, unknown>)['id']
  return typeof id === 'string' ? id : null
}

function extractExtraCount(extra: unknown): number | null {
  if (typeof extra !== 'object' || extra === null) return null
  const count = (extra as Record<string, unknown>)['count']
  if (typeof count === 'number') return count
  if (typeof count === 'string') {
    const parsed = Number(count)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function formatMessageContent(content: string | null): string {
  if (content === null || content.length === 0) return '*(내용 없음)*'
  const trimmed =
    content.length > MAX_CONTENT_LENGTH
      ? content.slice(0, MAX_CONTENT_LENGTH) + '…'
      : content
  return `\`\`\`\n${trimmed}\n\`\`\``
}

export function formatMessageDiff(
  oldContent: string | null,
  newContent: string | null
): string {
  const oldText = oldContent ?? ''
  const newText = newContent ?? ''

  const oldBlock =
    oldText.length > MAX_DIFF_LENGTH
      ? oldText.slice(0, MAX_DIFF_LENGTH) + '…'
      : oldText
  const newBlock =
    newText.length > MAX_DIFF_LENGTH
      ? newText.slice(0, MAX_DIFF_LENGTH) + '…'
      : newText

  return `**수정 전**\n\`\`\`\n${
    oldBlock || '(내용 없음)'
  }\n\`\`\`\n**수정 후**\n\`\`\`\n${newBlock || '(내용 없음)'}\n\`\`\``
}

export type MemberActivity = {
  readonly kind: 'join' | 'leave'
  readonly memberId: string
  readonly memberTag: string
  readonly isBot: boolean
  readonly accountCreatedTimestamp: number
  readonly isNewAccount: boolean
  readonly joinedTimestamp: number | null
  readonly stayDurationMs: number | null
  readonly memberCount: number | null
  readonly roles: readonly string[]
  readonly invite: InviteAttribution | null
}

export function describeMemberJoin(
  member: GuildMember,
  invite: InviteAttribution | null
): MemberActivity {
  const user = member.user
  return {
    accountCreatedTimestamp: user.createdTimestamp,
    invite,
    isBot: user.bot,
    isNewAccount: Date.now() - user.createdTimestamp < NEW_ACCOUNT_THRESHOLD_MS,
    joinedTimestamp: member.joinedTimestamp,
    kind: 'join',
    memberCount: member.guild.memberCount,
    memberId: user.id,
    memberTag: user.tag,
    roles: [],
    stayDurationMs: null,
  }
}

export function describeMemberLeave(
  member: GuildMember | PartialGuildMember
): MemberActivity {
  const user = member.user
  const joinedTimestamp = member.joinedTimestamp
  const roles = [...member.roles.cache.values()]
    .filter((role) => role.id !== member.guild.id)
    .map((role) => role.id)

  return {
    accountCreatedTimestamp: user.createdTimestamp,
    invite: null,
    isBot: user.bot,
    isNewAccount: Date.now() - user.createdTimestamp < NEW_ACCOUNT_THRESHOLD_MS,
    joinedTimestamp,
    kind: 'leave',
    memberCount: member.guild.memberCount,
    memberId: user.id,
    memberTag: user.tag,
    roles,
    stayDurationMs:
      joinedTimestamp !== null ? Date.now() - joinedTimestamp : null,
  }
}

export type ReactionActivity = {
  readonly kind: 'add' | 'remove'
  readonly channelId: string
  readonly messageId: string
  readonly userId: string
  readonly userTag: string
  readonly emoji: string
}

export async function describeReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User
): Promise<ReactionActivity | null> {
  if (reaction.message.guildId === null) return null

  return {
    channelId: reaction.message.channelId,
    emoji: formatEmoji(reaction.emoji),
    kind: 'add',
    messageId: reaction.message.id,
    userTag: user.tag,
    userId: user.id,
  }
}

export async function describeReactionRemove(
  reaction: MessageReaction | PartialMessageReaction,
  user: User
): Promise<ReactionActivity | null> {
  if (reaction.message.guildId === null) return null

  return {
    channelId: reaction.message.channelId,
    emoji: formatEmoji(reaction.emoji),
    kind: 'remove',
    messageId: reaction.message.id,
    userTag: user.tag,
    userId: user.id,
  }
}

export type ReactionClearActivity = {
  readonly kind: 'clearAll' | 'clearEmoji'
  readonly channelId: string
  readonly messageId: string
  readonly emoji: string | null
  readonly removedCount: number | null
}

export function describeReactionClearAll(
  message: Message | PartialMessage,
  reactions: Collection<string, MessageReaction>
): ReactionClearActivity {
  return {
    channelId: message.channelId,
    emoji: null,
    kind: 'clearAll',
    messageId: message.id,
    removedCount: reactions.size > 0 ? reactions.size : null,
  }
}

export function describeReactionClearEmoji(
  reaction: MessageReaction | PartialMessageReaction
): ReactionClearActivity {
  return {
    channelId: reaction.message.channelId,
    emoji: formatEmoji(reaction.emoji),
    kind: 'clearEmoji',
    messageId: reaction.message.id,
    removedCount: reaction.count,
  }
}

function formatEmoji(emoji: MessageReaction['emoji']): string {
  if (emoji.id !== null) {
    return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`
  }
  return emoji.name ?? '?'
}
