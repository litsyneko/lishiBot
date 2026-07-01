import { AuditLogEvent } from 'discord.js'

export const SERVER_LOG_CATEGORIES = [
  'server',
  'channels',
  'roles',
  'members',
  'moderation',
  'messages',
  'invites',
  'webhooks',
  'expressions',
] as const

export type ServerLogCategory = (typeof SERVER_LOG_CATEGORIES)[number]

export type ServerLogCategoryDefinition = {
  readonly description: string
  readonly id: ServerLogCategory
  readonly label: string
}

export const SERVER_LOG_CATEGORY_DEFINITIONS: readonly ServerLogCategoryDefinition[] =
  [
    {
      id: 'server',
      label: '서버 설정',
      description: '서버 정보, 이벤트, 연동, 온보딩, 명령 권한 변경',
    },
    {
      id: 'channels',
      label: '채널/스레드',
      description: '채널, 스레드, 권한 오버라이트 생성/수정/삭제',
    },
    { id: 'roles', label: '역할', description: '역할 생성/수정/삭제' },
    {
      id: 'members',
      label: '멤버 관리',
      description: '닉네임, 역할, 음성 이동/연결 해제, 봇 추가',
    },
    {
      id: 'moderation',
      label: '제재',
      description: '킥, 밴/언밴, 프룬, 자동모드 실행 제재',
    },
    {
      id: 'messages',
      label: '메시지 관리',
      description: '메시지 삭제, 일괄 삭제, 고정/고정 해제',
    },
    { id: 'invites', label: '초대', description: '초대 생성/수정/삭제' },
    { id: 'webhooks', label: '웹훅', description: '웹훅 생성/수정/삭제' },
    {
      id: 'expressions',
      label: '표현 요소',
      description: '이모지, 스티커, 사운드보드 생성/수정/삭제',
    },
  ]

const SERVER_LOG_CATEGORY_SET: ReadonlySet<string> = new Set(
  SERVER_LOG_CATEGORIES
)

const AUDIT_ACTION_CATEGORY: Readonly<
  Partial<Record<AuditLogEvent, ServerLogCategory>>
> = {
  [AuditLogEvent.ApplicationCommandPermissionUpdate]: 'server',
  [AuditLogEvent.BotAdd]: 'members',
  [AuditLogEvent.ChannelCreate]: 'channels',
  [AuditLogEvent.ChannelDelete]: 'channels',
  [AuditLogEvent.ChannelOverwriteCreate]: 'channels',
  [AuditLogEvent.ChannelOverwriteDelete]: 'channels',
  [AuditLogEvent.ChannelOverwriteUpdate]: 'channels',
  [AuditLogEvent.ChannelUpdate]: 'channels',
  [AuditLogEvent.EmojiCreate]: 'expressions',
  [AuditLogEvent.EmojiDelete]: 'expressions',
  [AuditLogEvent.EmojiUpdate]: 'expressions',
  [AuditLogEvent.GuildScheduledEventCreate]: 'server',
  [AuditLogEvent.GuildScheduledEventDelete]: 'server',
  [AuditLogEvent.GuildScheduledEventUpdate]: 'server',
  [AuditLogEvent.GuildUpdate]: 'server',
  [AuditLogEvent.IntegrationCreate]: 'server',
  [AuditLogEvent.IntegrationDelete]: 'server',
  [AuditLogEvent.IntegrationUpdate]: 'server',
  [AuditLogEvent.InviteCreate]: 'invites',
  [AuditLogEvent.InviteDelete]: 'invites',
  [AuditLogEvent.InviteUpdate]: 'invites',
  [AuditLogEvent.MemberBanAdd]: 'moderation',
  [AuditLogEvent.MemberBanRemove]: 'moderation',
  [AuditLogEvent.MemberDisconnect]: 'members',
  [AuditLogEvent.MemberKick]: 'moderation',
  [AuditLogEvent.MemberMove]: 'members',
  [AuditLogEvent.MemberPrune]: 'moderation',
  [AuditLogEvent.MemberRoleUpdate]: 'members',
  [AuditLogEvent.MemberUpdate]: 'members',
  [AuditLogEvent.MessageBulkDelete]: 'messages',
  [AuditLogEvent.MessageDelete]: 'messages',
  [AuditLogEvent.MessagePin]: 'messages',
  [AuditLogEvent.MessageUnpin]: 'messages',
  [AuditLogEvent.RoleCreate]: 'roles',
  [AuditLogEvent.RoleDelete]: 'roles',
  [AuditLogEvent.RoleUpdate]: 'roles',
  [AuditLogEvent.SoundboardSoundCreate]: 'expressions',
  [AuditLogEvent.SoundboardSoundDelete]: 'expressions',
  [AuditLogEvent.SoundboardSoundUpdate]: 'expressions',
  [AuditLogEvent.StageInstanceCreate]: 'server',
  [AuditLogEvent.StageInstanceDelete]: 'server',
  [AuditLogEvent.StageInstanceUpdate]: 'server',
  [AuditLogEvent.StickerCreate]: 'expressions',
  [AuditLogEvent.StickerDelete]: 'expressions',
  [AuditLogEvent.StickerUpdate]: 'expressions',
  [AuditLogEvent.ThreadCreate]: 'channels',
  [AuditLogEvent.ThreadDelete]: 'channels',
  [AuditLogEvent.ThreadUpdate]: 'channels',
  [AuditLogEvent.WebhookCreate]: 'webhooks',
  [AuditLogEvent.WebhookDelete]: 'webhooks',
  [AuditLogEvent.WebhookUpdate]: 'webhooks',
  [AuditLogEvent.AutoModerationBlockMessage]: 'moderation',
  [AuditLogEvent.AutoModerationFlagToChannel]: 'moderation',
  [AuditLogEvent.AutoModerationQuarantineUser]: 'moderation',
  [AuditLogEvent.AutoModerationUserCommunicationDisabled]: 'moderation',
  [AuditLogEvent.CreatorMonetizationRequestCreated]: 'server',
  [AuditLogEvent.CreatorMonetizationTermsAccepted]: 'server',
  [AuditLogEvent.HomeSettingsCreate]: 'server',
  [AuditLogEvent.HomeSettingsUpdate]: 'server',
  [AuditLogEvent.OnboardingCreate]: 'server',
  [AuditLogEvent.OnboardingPromptCreate]: 'server',
  [AuditLogEvent.OnboardingPromptDelete]: 'server',
  [AuditLogEvent.OnboardingPromptUpdate]: 'server',
  [AuditLogEvent.OnboardingUpdate]: 'server',
  [AuditLogEvent.VoiceChannelStatusCreate]: 'channels',
  [AuditLogEvent.VoiceChannelStatusDelete]: 'channels',
}

export function categoryForAuditAction(
  action: AuditLogEvent
): ServerLogCategory | null {
  return AUDIT_ACTION_CATEGORY[action] ?? null
}

export function isServerLogCategory(value: string): value is ServerLogCategory {
  return SERVER_LOG_CATEGORY_SET.has(value)
}
