import { formatAuditChange } from './auditLogFormatter'
import {
  SERVER_LOG_CATEGORY_DEFINITIONS,
  type ServerLogCategory,
} from './serverLogCategories'
import {
  type BulkDeleteDetails,
  type MemberActivity,
  type MessageActivity,
  type ReactionActivity,
  type ReactionClearActivity,
  type VoiceActivity,
  describeVoiceActivity,
  formatMessageContent,
  formatMessageDiff,
} from './serverLogEvents'
import {
  ContainerBuilder,
  FileBuilder,
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
  [AuditLogEvent.AutoModerationRuleCreate]: '자동 모드 규칙 생성',
  [AuditLogEvent.AutoModerationRuleDelete]: '자동 모드 규칙 삭제',
  [AuditLogEvent.AutoModerationRuleUpdate]: '자동 모드 규칙 수정',
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
  automod: 0xe74c3c,
  channels: 0x3498db,
  clantag: 0xe67e22,
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

const MAX_CHANGE_FIELDS = 10
const MAX_ATTACHMENT_LINES = 8
const MAX_ROLE_MENTIONS = 15
const MAX_AUTHOR_BREAKDOWN = 5

const OVERWRITE_ACTIONS: ReadonlySet<AuditLogEvent> = new Set([
  AuditLogEvent.ChannelOverwriteCreate,
  AuditLogEvent.ChannelOverwriteDelete,
  AuditLogEvent.ChannelOverwriteUpdate,
])

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
  const extra = formatExtra(entry, guild)
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
      )}\n-# ${categoryLabel} · ${nowTimestamp()}`
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

  appendFooter(container, footerText, `User ID: ${activity.memberId}`)

  return container
}

export function buildMessageLogMessage(
  activity: MessageActivity,
  category: ServerLogCategory,
  guild: Guild | undefined,
  client: Client | undefined
): ContainerBuilder {
  const categoryLabel = categoryLabelFor(category)
  const title = messageActivityTitle(activity)
  const channelRef =
    guild !== undefined ? `<#${activity.channelId}>` : activity.channelId
  const authorAvatar = resolveUserAvatar(guild, activity.authorId)
  const footerText = formatFooter(client)

  const container = new ContainerBuilder()
    .setAccentColor(CATEGORY_COLORS[category])
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${title}\n-# ${categoryLabel} · ${nowTimestamp()}`
      )
    )
    .addSeparatorComponents(buildDivider())

  const authorLine =
    activity.authorId !== null
      ? `<@${activity.authorId}>${
          activity.authorTag !== null ? ` (${activity.authorTag})` : ''
        }`
      : '알 수 없음 (캐시되지 않은 메시지)'

  const authorLabel =
    activity.authorIsBot === true ? `${authorLine} · 봇` : authorLine
  const headerLines = [`채널: ${channelRef}`, `작성자: ${authorLabel}`]

  if (activity.createdTimestamp !== null) {
    const seconds = Math.floor(activity.createdTimestamp / 1000)
    headerLines.push(`작성 시각: <t:${seconds}:f> (<t:${seconds}:R>)`)
  }

  if (activity.kind === 'edit' && guild !== undefined) {
    headerLines.push(
      `메시지: [바로가기](${messageJumpLink(
        guild.id,
        activity.channelId,
        activity.messageId
      )})`
    )
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
    const contentChanged = activity.oldContent !== activity.newContent
    if (contentChanged) {
      const oldForDiff =
        activity.oldContent === null && activity.contentUnavailable
          ? '(캐시되지 않은 메시지 — 수정 전 내용 알 수 없음)'
          : activity.oldContent
      container
        .addSeparatorComponents(buildDivider())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### 내용 변화\n${formatMessageDiff(
              oldForDiff,
              activity.newContent
            )}`
          )
        )
    }

    if (activity.attachments.length > 0) {
      container
        .addSeparatorComponents(buildDivider())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### 제거된 첨부 (${
              activity.attachments.length
            }개)\n${formatAttachmentLines(activity.attachments)}`
          )
        )
    }
  } else if (activity.kind === 'delete') {
    const deleterLine =
      activity.deleterId !== null
        ? `<@${activity.deleterId}>${
            activity.deleterTag !== null ? ` (${activity.deleterTag})` : ''
          }`
        : '-# 알 수 없음 (본인 삭제 또는 감사 로그 미확보)'

    const deletedContent =
      activity.oldContent === null && activity.contentUnavailable
        ? '*(캐시되지 않은 메시지라 내용을 확인할 수 없어요)*'
        : formatMessageContent(activity.oldContent)

    container
      .addSeparatorComponents(buildDivider())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 삭제된 내용\n${deletedContent}`
        )
      )

    if (activity.attachments.length > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**첨부 파일 (${
            activity.attachments.length
          }개)**\n${formatAttachmentLines(
            activity.attachments
          )}\n-# 첨부 링크는 시간이 지나면 만료될 수 있어요.`
        )
      )
    }

    if (activity.stickerNames.length > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**스티커**: ${activity.stickerNames.join(', ')}`
        )
      )
    }

    container
      .addSeparatorComponents(buildDivider())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### 삭제자\n${deleterLine}`)
      )
  }

  appendFooter(container, footerText, `Message ID: ${activity.messageId}`)

  return container
}

function formatAttachmentLines(
  attachments: MessageActivity['attachments']
): string {
  const lines = attachments
    .slice(0, MAX_ATTACHMENT_LINES)
    .map((attachment) => `- [${attachment.name}](${attachment.url})`)
  if (attachments.length > MAX_ATTACHMENT_LINES) {
    lines.push(`-# 외 ${attachments.length - MAX_ATTACHMENT_LINES}개`)
  }
  return lines.join('\n')
}

export function buildBulkDeleteLogMessage(
  details: BulkDeleteDetails,
  category: ServerLogCategory,
  guild: Guild | undefined,
  client: Client | undefined,
  transcriptFileName: string | null
): ContainerBuilder {
  const categoryLabel = categoryLabelFor(category)
  const channelRef =
    guild !== undefined ? `<#${details.channelId}>` : details.channelId
  const footerText = formatFooter(client)

  const container = new ContainerBuilder()
    .setAccentColor(CATEGORY_COLORS[category])
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 메시지 일괄 삭제\n-# ${categoryLabel} · ${nowTimestamp()}`
      )
    )
    .addSeparatorComponents(buildDivider())

  const infoLines = [`채널: ${channelRef}`, `삭제된 메시지: ${details.count}개`]
  if (details.uncachedCount > 0) {
    infoLines.push(
      `-# 이 중 ${details.uncachedCount}개는 캐시에 없어 내용을 확보하지 못했어요.`
    )
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### 삭제 정보\n${infoLines.join('\n')}`
    )
  )

  if (details.authorCounts.length > 0) {
    const breakdown = details.authorCounts
      .slice(0, MAX_AUTHOR_BREAKDOWN)
      .map(
        (item) =>
          `- <@${item.authorId}>${
            item.authorTag !== null ? ` (${item.authorTag})` : ''
          }: ${item.count}개`
      )
    if (details.authorCounts.length > MAX_AUTHOR_BREAKDOWN) {
      breakdown.push(
        `-# 외 ${details.authorCounts.length - MAX_AUTHOR_BREAKDOWN}명`
      )
    }
    container
      .addSeparatorComponents(buildDivider())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 작성자별 분포\n${breakdown.join('\n')}`
        )
      )
  }

  if (transcriptFileName !== null) {
    container
      .addSeparatorComponents(buildDivider())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('### 삭제된 메시지 기록')
      )
      .addFileComponents(
        new FileBuilder().setURL(`attachment://${transcriptFileName}`)
      )
  }

  appendFooter(container, footerText, `Channel ID: ${details.channelId}`)

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
        `# ${title}\n-# ${categoryLabel} · ${nowTimestamp()}`
      )
    )
    .addSeparatorComponents(buildDivider())

  const memberLine = `멤버: <@${activity.memberId}> (${activity.memberTag})${
    activity.isBot ? ' · 봇' : ''
  }`
  const createdSeconds = Math.floor(activity.accountCreatedTimestamp / 1000)
  const accountLine = `계정 생성: <t:${createdSeconds}:f> (<t:${createdSeconds}:R>)${
    activity.isNewAccount ? ' · ⚠️ **신규 계정**' : ''
  }`

  const infoLines: (string | null)[] = [memberLine, accountLine]

  if (activity.kind === 'join') {
    infoLines.push(
      activity.memberCount !== null
        ? `현재 인원: ${activity.memberCount}명`
        : null
    )
    if (activity.invite !== null) {
      const inviterPart =
        activity.invite.inviterId !== null
          ? ` · 초대자 <@${activity.invite.inviterId}>${
              activity.invite.inviterTag !== null
                ? ` (${activity.invite.inviterTag})`
                : ''
            }`
          : ''
      infoLines.push(
        activity.invite.isVanity
          ? `초대 경로: 커스텀 URL (\`${activity.invite.code}\`)`
          : `초대 경로: \`${activity.invite.code}\`${inviterPart}`
      )
    }
  } else {
    if (activity.joinedTimestamp !== null) {
      const joinedSeconds = Math.floor(activity.joinedTimestamp / 1000)
      infoLines.push(
        `서버 참가: <t:${joinedSeconds}:f> (<t:${joinedSeconds}:R>)`
      )
    }
    infoLines.push(
      activity.stayDurationMs !== null
        ? `머문 기간: ${formatStayDuration(activity.stayDurationMs)}`
        : null
    )
    infoLines.push(
      activity.memberCount !== null
        ? `현재 인원: ${activity.memberCount}명`
        : null
    )
    infoLines.push(formatRoleMentions(activity.roles))
  }

  const infoText = new TextDisplayBuilder().setContent(
    `### 멤버 정보\n${infoLines
      .filter((line): line is string => line !== null)
      .join('\n')}`
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

function formatRoleMentions(roles: readonly string[]): string | null {
  if (roles.length === 0) return null
  const shown = roles
    .slice(0, MAX_ROLE_MENTIONS)
    .map((id) => `<@&${id}>`)
    .join(', ')
  return roles.length > MAX_ROLE_MENTIONS
    ? `역할: ${shown} 외 ${roles.length - MAX_ROLE_MENTIONS}개`
    : `역할: ${shown}`
}

function formatStayDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 1)}분`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 ${minutes % 60}분`
  const days = Math.floor(hours / 24)
  return `${days}일 ${hours % 24}시간`
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
  const messageRef =
    guild !== undefined
      ? `[바로가기](${messageJumpLink(
          guild.id,
          activity.channelId,
          activity.messageId
        )})`
      : activity.messageId

  const container = new ContainerBuilder()
    .setAccentColor(CATEGORY_COLORS[category])
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${title}\n-# ${categoryLabel} · ${nowTimestamp()}`
      )
    )
    .addSeparatorComponents(buildDivider())

  const infoText = new TextDisplayBuilder().setContent(
    `### 반응 정보\n사용자: <@${activity.userId}> (${activity.userTag})\n채널: ${channelRef}\n메시지: ${messageRef}\n이모지: ${activity.emoji}`
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

export function buildReactionClearLogMessage(
  activity: ReactionClearActivity,
  category: ServerLogCategory,
  guild: Guild | undefined,
  client: Client | undefined
): ContainerBuilder {
  const categoryLabel = categoryLabelFor(category)
  const title =
    activity.kind === 'clearAll' ? '반응 전체 제거' : '특정 이모지 반응 제거'
  const channelRef =
    guild !== undefined ? `<#${activity.channelId}>` : activity.channelId
  const footerText = formatFooter(client)
  const messageRef =
    guild !== undefined
      ? `[바로가기](${messageJumpLink(
          guild.id,
          activity.channelId,
          activity.messageId
        )})`
      : activity.messageId

  const infoLines = [`채널: ${channelRef}`, `메시지: ${messageRef}`]
  if (activity.kind === 'clearEmoji' && activity.emoji !== null) {
    infoLines.push(
      `이모지: ${activity.emoji}${
        activity.removedCount !== null
          ? ` (${activity.removedCount}개 제거)`
          : ''
      }`
    )
  } else if (activity.removedCount !== null) {
    infoLines.push(`제거된 이모지 종류: ${activity.removedCount}종`)
  }

  const container = new ContainerBuilder()
    .setAccentColor(CATEGORY_COLORS[category])
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${title}\n-# ${categoryLabel} · ${nowTimestamp()}`
      )
    )
    .addSeparatorComponents(buildDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 반응 정보\n${infoLines.join('\n')}`
      )
    )

  appendFooter(container, footerText, `Message ID: ${activity.messageId}`)

  return container
}

function messageJumpLink(
  guildId: string,
  channelId: string,
  messageId: string
): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}

function nowTimestamp(): string {
  return `<t:${Math.floor(Date.now() / 1000)}:F>`
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

function formatExtra(
  entry: GuildAuditLogsEntry,
  guild: Guild | undefined
): string | null {
  const extra: unknown = entry.extra
  if (extra === null || extra === undefined) return null
  if (!isRecord(extra)) return null

  const parts: string[] = []

  const removed = extra['removed']
  const days = extra['days']
  if (typeof removed === 'number' && typeof days === 'number') {
    parts.push(`정리 대상: ${removed}명 (${days}일 이상 미접속)`)
  }

  if (OVERWRITE_ACTIONS.has(entry.action)) {
    const target = formatOverwriteTarget(extra, guild)
    if (target !== null) parts.push(`권한 대상: ${target}`)
  }

  const ruleName = extra['autoModerationRuleName']
  if (typeof ruleName === 'string' && ruleName.length > 0) {
    parts.push(`규칙: ${ruleName}`)
  }

  const count = extra['count']
  if (typeof count === 'number' && !(typeof removed === 'number')) {
    parts.push(`건수: ${count}`)
  }

  const channel = extra['channel']
  if (isRecord(channel)) {
    const channelId = channel['id']
    if (typeof channelId === 'string') {
      parts.push(`관련 채널: <#${channelId}>`)
    }
  }

  return parts.length === 0 ? null : parts.join(' · ')
}

/** 채널 권한 오버라이트가 어느 역할/멤버 대상인지 표시한다. */
function formatOverwriteTarget(
  extra: Readonly<Record<string, unknown>>,
  guild: Guild | undefined
): string | null {
  const id = extra['id']
  if (typeof id !== 'string' || id.length === 0) return null

  if (guild !== undefined) {
    if (guild.roles.cache.has(id)) return `<@&${id}> (역할)`
    if (guild.members.cache.has(id)) return `<@${id}> (멤버)`
  }

  const rawType = extra['type']
  const isMember =
    rawType === 1 || rawType === '1' || 'user' in extra || 'nick' in extra
  return isMember ? `<@${id}> (멤버)` : `<@&${id}> (역할)`
}

function formatChanges(
  changes: GuildAuditLogsEntry['changes'],
  guild: Guild | undefined
): string | null {
  if (changes.length === 0) return null

  const formatted = changes.slice(0, MAX_CHANGE_FIELDS).map((change) => {
    const field = formatAuditChange(
      { key: change.key, new: change.new, old: change.old },
      guild
    )
    return `- **${field.label}**: ${field.display}`
  })

  if (changes.length > MAX_CHANGE_FIELDS) {
    formatted.push(`-# 외 ${changes.length - MAX_CHANGE_FIELDS}개 변경 생략`)
  }

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
    case 'serverMute':
      return '서버 음소거'
    case 'serverUnmute':
      return '서버 음소거 해제'
    case 'serverDeafen':
      return '서버 청각 차단'
    case 'serverUndeafen':
      return '서버 청각 차단 해제'
    case 'streamStart':
      return '방송 시작'
    case 'streamStop':
      return '방송 종료'
    case 'videoStart':
      return '카메라 켬'
    case 'videoStop':
      return '카메라 끔'
  }
}

function messageActivityTitle(activity: MessageActivity): string {
  switch (activity.kind) {
    case 'edit':
      return '메시지 수정'
    case 'delete':
      return activity.authorIsBot === true ? '봇 메시지 삭제' : '메시지 삭제'
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
