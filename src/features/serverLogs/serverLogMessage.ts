import { formatAuditChange } from './auditLogFormatter'
import {
  SERVER_LOG_CATEGORY_DEFINITIONS,
  type ServerLogCategory,
} from './serverLogCategories'
import {
  type MemberActivity,
  type MessageActivity,
  type ReactionActivity,
  type VoiceActivity,
  describeVoiceActivity,
  formatMessageContent,
  formatMessageDiff,
} from './serverLogEvents'
import {
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from '@discordjs/builders'
import type { Client, Guild } from 'discord.js'
import {
  AuditLogEvent,
  type GuildAuditLogsEntry,
  SeparatorSpacingSize,
} from 'discord.js'

const ACTION_LABELS: Readonly<Partial<Record<AuditLogEvent, string>>> = {
  [AuditLogEvent.ApplicationCommandPermissionUpdate]: '앱 명령어 권한 변경',
  [AuditLogEvent.AutoModerationBlockMessage]: '자동 모드 메시지 차단',
  [AuditLogEvent.AutoModerationFlagToChannel]: '자동 모드 채널 알림',
  [AuditLogEvent.AutoModerationQuarantineUser]: '자동 모드 격리',
  [AuditLogEvent.AutoModerationUserCommunicationDisabled]: '자동 모드 타임아웃',
  [AuditLogEvent.BotAdd]: '봇 추가',
  [AuditLogEvent.ChannelCreate]: '채널 생성',
  [AuditLogEvent.ChannelDelete]: '채널 삭제',
  [AuditLogEvent.ChannelOverwriteCreate]: '채널 권한 추가',
  [AuditLogEvent.ChannelOverwriteDelete]: '채널 권한 삭제',
  [AuditLogEvent.ChannelOverwriteUpdate]: '채널 권한 수정',
  [AuditLogEvent.ChannelUpdate]: '채널 수정',
  [AuditLogEvent.CreatorMonetizationRequestCreated]: '크리에이터 수익화 요청',
  [AuditLogEvent.CreatorMonetizationTermsAccepted]:
    '크리에이터 수익화 약관 동의',
  [AuditLogEvent.EmojiCreate]: '이모지 생성',
  [AuditLogEvent.EmojiDelete]: '이모지 삭제',
  [AuditLogEvent.EmojiUpdate]: '이모지 수정',
  [AuditLogEvent.GuildScheduledEventCreate]: '서버 이벤트 생성',
  [AuditLogEvent.GuildScheduledEventDelete]: '서버 이벤트 삭제',
  [AuditLogEvent.GuildScheduledEventUpdate]: '서버 이벤트 수정',
  [AuditLogEvent.GuildUpdate]: '서버 설정 수정',
  [AuditLogEvent.HomeSettingsCreate]: '서버 홈 설정 생성',
  [AuditLogEvent.HomeSettingsUpdate]: '서버 홈 설정 수정',
  [AuditLogEvent.IntegrationCreate]: '연동 생성',
  [AuditLogEvent.IntegrationDelete]: '연동 삭제',
  [AuditLogEvent.IntegrationUpdate]: '연동 수정',
  [AuditLogEvent.InviteCreate]: '초대 생성',
  [AuditLogEvent.InviteDelete]: '초대 삭제',
  [AuditLogEvent.InviteUpdate]: '초대 수정',
  [AuditLogEvent.MemberBanAdd]: '멤버 밴',
  [AuditLogEvent.MemberBanRemove]: '멤버 언밴',
  [AuditLogEvent.MemberDisconnect]: '멤버 음성 연결 해제',
  [AuditLogEvent.MemberKick]: '멤버 추방',
  [AuditLogEvent.MemberMove]: '멤버 음성 이동',
  [AuditLogEvent.MemberPrune]: '멤버 정리',
  [AuditLogEvent.MemberRoleUpdate]: '멤버 역할 변경',
  [AuditLogEvent.MemberUpdate]: '멤버 정보 수정',
  [AuditLogEvent.MessageBulkDelete]: '메시지 일괄 삭제',
  [AuditLogEvent.MessageDelete]: '메시지 삭제',
  [AuditLogEvent.MessagePin]: '메시지 고정',
  [AuditLogEvent.MessageUnpin]: '메시지 고정 해제',
  [AuditLogEvent.OnboardingCreate]: '온보딩 생성',
  [AuditLogEvent.OnboardingPromptCreate]: '온보딩 질문 생성',
  [AuditLogEvent.OnboardingPromptDelete]: '온보딩 질문 삭제',
  [AuditLogEvent.OnboardingPromptUpdate]: '온보딩 질문 수정',
  [AuditLogEvent.OnboardingUpdate]: '온보딩 수정',
  [AuditLogEvent.RoleCreate]: '역할 생성',
  [AuditLogEvent.RoleDelete]: '역할 삭제',
  [AuditLogEvent.RoleUpdate]: '역할 수정',
  [AuditLogEvent.SoundboardSoundCreate]: '사운드보드 생성',
  [AuditLogEvent.SoundboardSoundDelete]: '사운드보드 삭제',
  [AuditLogEvent.SoundboardSoundUpdate]: '사운드보드 수정',
  [AuditLogEvent.StageInstanceCreate]: '스테이지 생성',
  [AuditLogEvent.StageInstanceDelete]: '스테이지 삭제',
  [AuditLogEvent.StageInstanceUpdate]: '스테이지 수정',
  [AuditLogEvent.StickerCreate]: '스티커 생성',
  [AuditLogEvent.StickerDelete]: '스티커 삭제',
  [AuditLogEvent.StickerUpdate]: '스티커 수정',
  [AuditLogEvent.ThreadCreate]: '스레드 생성',
  [AuditLogEvent.ThreadDelete]: '스레드 삭제',
  [AuditLogEvent.ThreadUpdate]: '스레드 수정',
  [AuditLogEvent.VoiceChannelStatusCreate]: '음성 채널 상태 생성',
  [AuditLogEvent.VoiceChannelStatusDelete]: '음성 채널 상태 삭제',
  [AuditLogEvent.WebhookCreate]: '웹훅 생성',
  [AuditLogEvent.WebhookDelete]: '웹훅 삭제',
  [AuditLogEvent.WebhookUpdate]: '웹훅 수정',
}

const CATEGORY_COLORS: Readonly<Record<ServerLogCategory, number>> = {
  channels: 0x3498db,
  expressions: 0xf1c40f,
  invites: 0x1abc9c,
  members: 0x9b59b6,
  messages: 0x95a5a6,
  moderation: 0xe74c3c,
  roles: 0x5865f2,
  server: 0x2ecc71,
  voice: 0x1abc9c,
  webhooks: 0x34495e,
}

export function buildServerLogMessage(
  entry: GuildAuditLogsEntry,
  category: ServerLogCategory,
  guild: Guild | undefined,
  client: Client | undefined
): ContainerBuilder {
  const categoryLabel = categoryLabelFor(category)
  const actionLabel = ACTION_LABELS[entry.action] ?? `관리 작업 ${entry.action}`
  const executor = formatExecutor(entry.executorId)
  const target = formatTarget(entry)
  const reason = formatReason(entry.reason)
  const extra = formatExtra(entry)
  const changes = formatChanges(entry.changes, guild)
  const actionKind = actionKindOf(entry.action)
  const executorAvatar = resolveUserAvatar(guild, entry.executorId)
  const footerText = formatFooter(client)

  const container = new ContainerBuilder()
    .setAccentColor(CATEGORY_COLORS[category])
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${actionLabel}\n-# ${categoryLabel} · <t:${Math.floor(
          entry.createdTimestamp / 1000
        )}:F>`
      )
    )
    .addSeparatorComponents(buildDivider())

  const infoLines = [
    `실행자: ${executor}`,
    `대상: ${target}`,
    extra !== null ? extra : null,
    reason !== null ? `사유: ${reason}` : null,
  ].filter((line): line is string => line !== null)

  const infoText = new TextDisplayBuilder().setContent(
    `### 실행 정보\n${infoLines.join('\n')}`
  )

  if (executorAvatar !== null) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(infoText)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(executorAvatar))
    container.addSectionComponents(section)
  } else {
    container.addTextDisplayComponents(infoText)
  }

  if (changes !== null) {
    container
      .addSeparatorComponents(buildDivider())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### 변경 내역\n${changes}`)
      )
  } else if (actionKind === 'update') {
    container
      .addSeparatorComponents(buildDivider())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '### 변경 내역\n-# 이번 작업에서는 상세 변경 필드가 제공되지 않았어요.'
        )
      )
  }

  if (footerText !== null) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${footerText} · Audit Log ID: ${entry.id}`
      )
    )
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# Audit Log ID: ${entry.id}`)
    )
  }

  return container
}

type ActionKind = 'create' | 'delete' | 'update' | 'other'

function actionKindOf(action: AuditLogEvent): ActionKind {
  const name = AuditLogEvent[action]
  if (name === undefined) return 'other'
  if (name.endsWith('Create')) return 'create'
  if (name.endsWith('Delete')) return 'delete'
  if (name.endsWith('Update')) return 'update'
  return 'other'
}

function formatReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null
  const trimmed = reason.trim()
  if (trimmed.length === 0) return null
  return trimmed
}

export function buildVoiceLogMessage(
  activity: VoiceActivity,
  category: ServerLogCategory,
  guild: Guild | undefined,
  client: Client | undefined
): ContainerBuilder {
  const categoryLabel = categoryLabelFor(category)
  const description = describeVoiceActivity(activity)
  const channelText =
    activity.channelId !== null ? `<#${activity.channelId}>` : '알 수 없음'
  const memberAvatar = resolveUserAvatar(guild, activity.memberId)
  const footerText = formatFooter(client)

  const container = new ContainerBuilder().setAccentColor(
    CATEGORY_COLORS[category]
  )

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 음성 활동: ${activityKindLabel(
        activity.kind
      )}\n-# ${categoryLabel} · <t:${Math.floor(Date.now() / 1000)}:T>`
    )
  )
  container.addSeparatorComponents(buildDivider())

  const infoText = new TextDisplayBuilder().setContent(
    `### 활동 내역\n${description}\n\n멤버: <@${activity.memberId}> (${activity.memberTag})\n채널: ${channelText}`
  )

  if (memberAvatar !== null) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(infoText)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(memberAvatar))
    container.addSectionComponents(section)
  } else {
    container.addTextDisplayComponents(infoText)
  }

  appendFooter(container, footerText, `Message ID: voice-${activity.memberId}`)

  return container
}

export function buildMessageLogMessage(
  activity: MessageActivity,
  category: ServerLogCategory,
  guild: Guild | undefined,
  client: Client | undefined
): ContainerBuilder {
  const categoryLabel = categoryLabelFor(category)
  const title = messageActivityTitle(activity.kind)
  const channelRef =
    guild !== undefined ? `<#${activity.channelId}>` : activity.channelId
  const authorAvatar = resolveUserAvatar(guild, activity.authorId)
  const footerText = formatFooter(client)

  const container = new ContainerBuilder()
    .setAccentColor(CATEGORY_COLORS[category])
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${title}\n-# ${categoryLabel} · <t:${Math.floor(
          Date.now() / 1000
        )}:T>`
      )
    )
    .addSeparatorComponents(buildDivider())

  const authorLine =
    activity.authorId !== null
      ? `<@${activity.authorId}>${
          activity.authorTag !== null ? ` (${activity.authorTag})` : ''
        }`
      : '알 수 없음'

  const headerLines = [`채널: ${channelRef}`, `작성자: ${authorLine}`]
  if (activity.count !== null) {
    headerLines.push(`삭제된 메시지 수: ${activity.count}개`)
  }

  const infoText = new TextDisplayBuilder().setContent(
    `### 메시지 정보\n${headerLines.join('\n')}`
  )

  if (authorAvatar !== null) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(infoText)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(authorAvatar))
    container.addSectionComponents(section)
  } else {
    container.addTextDisplayComponents(infoText)
  }

  if (activity.kind === 'edit') {
    container
      .addSeparatorComponents(buildDivider())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 내용 변화\n${formatMessageDiff(
            activity.oldContent,
            activity.newContent
          )}`
        )
      )
  } else if (activity.kind === 'delete') {
    container
      .addSeparatorComponents(buildDivider())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 삭제된 내용\n${formatMessageContent(activity.oldContent)}`
        )
      )
  }

  appendFooter(container, footerText, `Message ID: ${activity.messageId}`)

  return container
}

export function buildMemberLogMessage(
  activity: MemberActivity,
  category: ServerLogCategory,
  guild: Guild | undefined,
  client: Client | undefined
): ContainerBuilder {
  const categoryLabel = categoryLabelFor(category)
  const title = activity.kind === 'join' ? '멤버 참가' : '멤버 퇴장'
  const memberAvatar = resolveUserAvatar(guild, activity.memberId)
  const footerText = formatFooter(client)

  const container = new ContainerBuilder()
    .setAccentColor(CATEGORY_COLORS[category])
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${title}\n-# ${categoryLabel} · <t:${Math.floor(
          Date.now() / 1000
        )}:T>`
      )
    )
    .addSeparatorComponents(buildDivider())

  const infoLines = [
    `멤버: <@${activity.memberId}> (${activity.memberTag})`,
    activity.accountAge !== null ? `계정 생성: ${activity.accountAge}` : null,
    activity.joinedServerAt !== null
      ? `서버 참가: ${activity.joinedServerAt}`
      : null,
    activity.roles.length > 0
      ? `역할: ${activity.roles.map((id) => `<@&${id}>`).join(', ')}`
      : null,
  ].filter((line): line is string => line !== null)

  const infoText = new TextDisplayBuilder().setContent(
    `### 멤버 정보\n${infoLines.join('\n')}`
  )

  if (memberAvatar !== null) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(infoText)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(memberAvatar))
    container.addSectionComponents(section)
  } else {
    container.addTextDisplayComponents(infoText)
  }

  appendFooter(container, footerText, `Member ID: ${activity.memberId}`)

  return container
}

export function buildReactionLogMessage(
  activity: ReactionActivity,
  category: ServerLogCategory,
  guild: Guild | undefined,
  client: Client | undefined
): ContainerBuilder {
  const categoryLabel = categoryLabelFor(category)
  const title = activity.kind === 'add' ? '반응 추가' : '반응 제거'
  const channelRef =
    guild !== undefined ? `<#${activity.channelId}>` : activity.channelId
  const userAvatar = resolveUserAvatar(guild, activity.userId)
  const footerText = formatFooter(client)

  const container = new ContainerBuilder()
    .setAccentColor(CATEGORY_COLORS[category])
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${title}\n-# ${categoryLabel} · <t:${Math.floor(
          Date.now() / 1000
        )}:T>`
      )
    )
    .addSeparatorComponents(buildDivider())

  const infoText = new TextDisplayBuilder().setContent(
    `### 반응 정보\n사용자: <@${activity.userId}> (${activity.userTag})\n채널: ${channelRef}\n메시지 ID: ${activity.messageId}\n이모지: ${activity.emoji}`
  )

  if (userAvatar !== null) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(infoText)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(userAvatar))
    container.addSectionComponents(section)
  } else {
    container.addTextDisplayComponents(infoText)
  }

  appendFooter(container, footerText, `Message ID: ${activity.messageId}`)

  return container
}

function buildDivider(): SeparatorBuilder {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Small)
}

function resolveUserAvatar(
  guild: Guild | undefined,
  userId: string | null
): string | null {
  if (guild === undefined || userId === null) return null

  const member = guild.members.cache.get(userId)
  if (member !== undefined) {
    const url = member.user.displayAvatarURL({ extension: 'png', size: 128 })
    if (url.length > 0) return url
  }

  return null
}

function formatFooter(client: Client | undefined): string | null {
  if (client === undefined) return null
  const user = client.user
  if (user === null) return null
  return `${user.username} 로그`
}

function appendFooter(
  container: ContainerBuilder,
  footerText: string | null,
  fallback: string
): void {
  const line =
    footerText !== null ? `-# ${footerText} · ${fallback}` : `-# ${fallback}`
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(line))
}

function categoryLabelFor(category: ServerLogCategory): string {
  return (
    SERVER_LOG_CATEGORY_DEFINITIONS.find((item) => item.id === category)
      ?.label ?? category
  )
}

function formatExecutor(executorId: string | null): string {
  return executorId === null ? '알 수 없음' : `<@${executorId}> (${executorId})`
}

function formatTarget(entry: GuildAuditLogsEntry): string {
  if (entry.targetId === null) return entry.targetType
  const targetName = formatNamedValue(entry.target)
  if (targetName !== null) return `${targetName} (${entry.targetId})`
  if (entry.targetType === 'Channel')
    return `<#${entry.targetId}> (${entry.targetId})`
  if (entry.targetType === 'Role')
    return `<@&${entry.targetId}> (${entry.targetId})`
  if (entry.targetType === 'User')
    return `<@${entry.targetId}> (${entry.targetId})`
  return `${entry.targetType} (${entry.targetId})`
}

function formatExtra(entry: GuildAuditLogsEntry): string | null {
  const extra: unknown = entry.extra
  if (extra === null || extra === undefined) return null

  if (!isRecord(extra)) return null

  const removed = extra['removed']
  const days = extra['days']
  if (typeof removed === 'number' && typeof days === 'number') {
    return `정리 대상: ${removed}명 (${days}일 이상 미접속)`
  }

  const count = extra['count']
  if (typeof count === 'number') {
    return `건수: ${count}`
  }

  const channel = extra['channel']
  if (isRecord(channel)) {
    const channelId = channel['id']
    if (typeof channelId === 'string') {
      return `관련 채널: <#${channelId}>`
    }
  }

  return null
}

function formatChanges(
  changes: GuildAuditLogsEntry['changes'],
  guild: Guild | undefined
): string | null {
  if (changes.length === 0) return null

  const formatted = changes.slice(0, 10).map((change) => {
    const field = formatAuditChange(
      { key: change.key, new: change.new, old: change.old },
      guild
    )
    return `- **${field.label}**: ${field.display}`
  })

  return formatted.join('\n')
}

function activityKindLabel(kind: VoiceActivity['kind']): string {
  switch (kind) {
    case 'join':
      return '참가'
    case 'leave':
      return '퇴장'
    case 'move':
      return '이동'
    case 'mute':
      return '음소거'
    case 'unmute':
      return '음소거 해제'
    case 'deafen':
      return '청각 차단'
    case 'undeafen':
      return '청각 차단 해제'
  }
}

function messageActivityTitle(kind: MessageActivity['kind']): string {
  switch (kind) {
    case 'edit':
      return '메시지 수정'
    case 'delete':
      return '메시지 삭제'
    case 'bulkDelete':
      return '메시지 일괄 삭제'
  }
}

function formatNamedValue(value: unknown): string | null {
  if (!isRecord(value)) return null

  const name = value['name']
  if (typeof name === 'string' && name.length > 0) return name

  const tag = value['tag']
  if (typeof tag === 'string' && tag.length > 0) return tag

  const id = value['id']
  if (typeof id === 'string' && id.length > 0) return id

  return null
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}
