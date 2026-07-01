import {
  SERVER_LOG_CATEGORY_DEFINITIONS,
  type ServerLogCategory,
} from './serverLogCategories'
import {
  ContainerBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from '@discordjs/builders'
import {
  AuditLogEvent,
  GuildAuditLogsEntry,
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
  webhooks: 0x34495e,
}

export function buildServerLogMessage(
  entry: GuildAuditLogsEntry,
  category: ServerLogCategory
): ContainerBuilder {
  const categoryLabel = categoryLabelFor(category)
  const actionLabel = ACTION_LABELS[entry.action] ?? `관리 작업 ${entry.action}`
  const executor = formatExecutor(entry.executorId)
  const target = formatTarget(entry)
  const reason = entry.reason ?? '기록된 사유 없음'
  const changes = formatChanges(entry.changes)

  return new ContainerBuilder()
    .setAccentColor(CATEGORY_COLORS[category])
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${actionLabel}\n-# ${categoryLabel} · <t:${Math.floor(
          entry.createdTimestamp / 1000
        )}:F>`
      )
    )
    .addSeparatorComponents(buildDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 실행 정보\n실행자: ${executor}\n대상: ${target}\n사유: ${reason}`
      )
    )
    .addSeparatorComponents(buildDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 변경 내역\n${changes}`)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# Audit Log ID: ${entry.id}`)
    )
}

function buildDivider(): SeparatorBuilder {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Small)
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

function formatChanges(changes: GuildAuditLogsEntry['changes']): string {
  if (changes.length === 0) return '상세 변경 필드가 제공되지 않았어요.'

  return changes
    .slice(0, 8)
    .map(
      (change) =>
        `- **${change.key}**: ${formatValue(change.old)} -> ${formatValue(
          change.new
        )}`
    )
    .join('\n')
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '없음'
  if (typeof value === 'string') return value.length === 0 ? '빈 값' : value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`

  const named = formatNamedValue(value)
  return named ?? '객체 값'
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
