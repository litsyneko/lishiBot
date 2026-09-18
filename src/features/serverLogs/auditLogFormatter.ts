import { type Guild, PermissionFlagsBits } from 'discord.js'

export type ChangeField = {
  readonly key: string
  readonly new: unknown
  readonly old: unknown
}

export type FormattedField = {
  readonly label: string
  readonly display: string
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  $add: '추가된 역할',
  $remove: '제거된 역할',
  actions: '자동 모드 조치',
  afk_channel_id: 'AFK 채널',
  afk_timeout: 'AFK 타임아웃',
  allow: '허용 권한',
  allow_list: '허용 단어 목록',
  application_id: '애플리케이션',
  applied_tags: '적용된 태그',
  archived: '보관 여부',
  asset: '자산',
  auto_archive_duration: '자동 보관 기간',
  available: '사용 가능',
  available_tags: '사용 가능 태그',
  avatar_hash: '아바타',
  banner_hash: '배너',
  bitrate: '비트레이트',
  channel_id: '채널',
  code: '초대 코드',
  color: '색상',
  communication_disabled_until: '타임아웃 종료',
  deaf: '청각 차단',
  default_auto_archive_duration: '기본 자동 보관 기간',
  default_forum_layout: '기본 포럼 레이아웃',
  default_message_notifications: '기본 알림 설정',
  default_reaction_emoji: '기본 반응 이모지',
  default_sort_order: '기본 정렬 방식',
  default_thread_rate_limit_per_user: '스레드 슬로우모드',
  deny: '거부 권한',
  description: '설명',
  discovery_splash_hash: '디스커버리 이미지',
  emoji_id: '이모지',
  emoji_name: '이모지 이름',
  enabled: '활성화',
  enable_emoticons: '이모티콘 활성화',
  entity_type: '엔티티 유형',
  event_type: '이벤트 유형',
  exempt_channels: '예외 채널',
  exempt_roles: '예외 역할',
  expire_behavior: '만료 동작',
  expire_grace_period: '만료 유예 기간',
  explicit_content_filter: '유해 콘텐츠 필터',
  flags: '플래그',
  format_type: '포맷 유형',
  guild_id: '서버',
  hoist: '표시 분리',
  icon_hash: '아이콘',
  id: 'ID',
  image_hash: '이미지',
  invitable: '초대 가능',
  inviter_id: '초대자',
  keyword_filter: '금지 키워드',
  location: '위치',
  locked: '잠금',
  max_age: '최대 기간',
  max_uses: '최대 사용 횟수',
  mention_total_limit: '멘션 최대 개수',
  mentionable: '멘션 가능',
  mfa_level: '2FA 단계',
  mute: '음소거',
  name: '이름',
  nick: '별명',
  nsfw: '연령 제한',
  owner_id: '소유자',
  permission_overwrites: '권한 오버라이트',
  permissions: '권한',
  position: '순서',
  preferred_locale: '선호 언어',
  premium_progress_bar_enabled: '부스트 진행바',
  presets: '검열 프리셋',
  privacy_level: '공개 범위',
  prune_delete_days: '프룬 삭제 일수',
  public_updates_channel_id: '업데이트 채널',
  rate_limit_per_user: '슬로우모드',
  regex_patterns: '정규식 패턴',
  region: '지역',
  rtc_region: 'RTC 지역',
  rules_channel_id: '규칙 채널',
  safety_alerts_channel_id: '안전 알림 채널',
  sound_id: '사운드',
  splash_hash: '스플래시 이미지',
  status: '상태',
  system_channel_flags: '시스템 채널 플래그',
  system_channel_id: '시스템 채널',
  tags: '태그',
  temporary: '임시',
  topic: '주제',
  trigger_metadata: '트리거 메타데이터',
  trigger_type: '트리거 유형',
  type: '유형',
  user_id: '사용자',
  user_limit: '사용자 제한',
  uses: '사용 횟수',
  vanity_url_code: '커스텀 URL',
  verification_level: '인증 단계',
  video_quality_mode: '화질 모드',
  volume: '볼륨',
  widget_channel_id: '위젯 채널',
  widget_enabled: '위젯 활성화',
}

const VERIFICATION_LEVELS = ['없음', '낮음', '중간', '높음', '매우 높음']

const EXPLICIT_FILTERS = ['비활성', '멤션 없는 사용자', '모든 멤버']

const NOTIFICATION_LEVELS = ['모든 메시지', '멘션만']

const VIDEO_QUALITY = ['자동', '720p']

const PRIVACY_LEVELS = ['서버', '공개']

const ENTITY_TYPES = ['독립 실행형', '채널', '외부']

const MFA_LEVELS = ['없음', '필수']

const EVENT_STATUS = ['알 수 없음', '예정됨', '진행 중', '종료됨', '취소됨']

const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  'archived',
  'available',
  'deaf',
  'enable_emoticons',
  'enabled',
  'hoist',
  'invitable',
  'locked',
  'mentionable',
  'mute',
  'nsfw',
  'premium_progress_bar_enabled',
  'temporary',
  'widget_enabled',
])

const CHANNEL_REFERENCE_KEYS: ReadonlySet<string> = new Set([
  'afk_channel_id',
  'application_id',
  'channel_id',
  'emoji_id',
  'guild_id',
  'inviter_id',
  'owner_id',
  'public_updates_channel_id',
  'rules_channel_id',
  'safety_alerts_channel_id',
  'sound_id',
  'system_channel_id',
  'user_id',
  'widget_channel_id',
])

export function formatAuditChange(
  change: ChangeField,
  guild: Guild | undefined
): FormattedField {
  const label = KEY_LABELS[change.key] ?? change.key
  const display = formatChangeValue(change, guild)
  return { label, display }
}

function formatChangeValue(
  change: ChangeField,
  guild: Guild | undefined
): string {
  const { key, old: oldValue, new: newValue } = change

  if (key === '$add' || key === '$remove') {
    return formatRoleList(newValue)
  }

  if (key === 'permissions' || key === 'allow' || key === 'deny') {
    return formatPermissionDiff(oldValue, newValue)
  }

  if (key === 'communication_disabled_until') {
    return `${formatIsoTimestamp(oldValue)} -> ${formatIsoTimestamp(newValue)}`
  }

  if (key === 'verification_level') {
    return `${VERIFICATION_LEVELS[asNumber(oldValue)] ?? '알 수 없음'} -> ${
      VERIFICATION_LEVELS[asNumber(newValue)] ?? '알 수 없음'
    }`
  }

  if (key === 'explicit_content_filter') {
    return `${EXPLICIT_FILTERS[asNumber(oldValue)] ?? '알 수 없음'} -> ${
      EXPLICIT_FILTERS[asNumber(newValue)] ?? '알 수 없음'
    }`
  }

  if (key === 'default_message_notifications') {
    return `${NOTIFICATION_LEVELS[asNumber(oldValue)] ?? '알 수 없음'} -> ${
      NOTIFICATION_LEVELS[asNumber(newValue)] ?? '알 수 없음'
    }`
  }

  if (key === 'video_quality_mode') {
    return `${VIDEO_QUALITY[asNumber(oldValue)] ?? '알 수 없음'} -> ${
      VIDEO_QUALITY[asNumber(newValue)] ?? '알 수 없음'
    }`
  }

  if (key === 'privacy_level') {
    return `${PRIVACY_LEVELS[asNumber(oldValue)] ?? '알 수 없음'} -> ${
      PRIVACY_LEVELS[asNumber(newValue)] ?? '알 수 없음'
    }`
  }

  if (key === 'entity_type') {
    return `${ENTITY_TYPES[asNumber(oldValue)] ?? '알 수 없음'} -> ${
      ENTITY_TYPES[asNumber(newValue)] ?? '알 수 없음'
    }`
  }

  if (key === 'mfa_level') {
    return `${MFA_LEVELS[asNumber(oldValue)] ?? '알 수 없음'} -> ${
      MFA_LEVELS[asNumber(newValue)] ?? '알 수 없음'
    }`
  }

  if (key === 'status' && isNumeric(oldValue) && isNumeric(newValue)) {
    return `${EVENT_STATUS[asNumber(oldValue)] ?? '알 수 없음'} -> ${
      EVENT_STATUS[asNumber(newValue)] ?? '알 수 없음'
    }`
  }

  if (key === 'color') {
    return `${formatColor(oldValue)} -> ${formatColor(newValue)}`
  }

  if (BOOLEAN_KEYS.has(key)) {
    return `${formatBoolean(oldValue)} -> ${formatBoolean(newValue)}`
  }

  if (key === 'position') {
    return `${asNumber(oldValue) + 1}번 -> ${asNumber(newValue) + 1}번`
  }

  if (key === 'bitrate') {
    return `${formatBitrate(oldValue)} -> ${formatBitrate(newValue)}`
  }

  if (key === 'afk_timeout') {
    return `${formatMinutes(oldValue)} -> ${formatMinutes(newValue)}`
  }

  if (key === 'max_age') {
    return `${formatDuration(oldValue)} -> ${formatDuration(newValue)}`
  }

  if (key === 'max_uses' || key === 'uses' || key === 'user_limit') {
    return `${formatNumber(oldValue)} -> ${formatNumber(newValue)}`
  }

  if (
    key === 'rate_limit_per_user' ||
    key === 'default_thread_rate_limit_per_user'
  ) {
    return `${formatSlowmode(oldValue)} -> ${formatSlowmode(newValue)}`
  }

  if (CHANNEL_REFERENCE_KEYS.has(key)) {
    return `${formatIdReference(oldValue, guild)} -> ${formatIdReference(
      newValue,
      guild
    )}`
  }

  if (key === 'keyword_filter' || key === 'allow_list') {
    return `${formatStringList(oldValue)} -> ${formatStringList(newValue)}`
  }

  if (key === 'exempt_channels') {
    return `${formatIdReferenceList(
      oldValue,
      guild
    )} -> ${formatIdReferenceList(newValue, guild)}`
  }

  if (key === 'exempt_roles') {
    return `${formatIdReferenceList(
      oldValue,
      guild
    )} -> ${formatIdReferenceList(newValue, guild)}`
  }

  return `${formatGenericType(oldValue)} -> ${formatGenericType(newValue)}`
}

function formatRoleList(value: unknown): string {
  if (!Array.isArray(value)) return '정보 없음'
  const roles = value
    .map((item) => {
      if (!isRecord(item)) return null
      const name = item['name']
      const id = item['id']
      if (typeof name === 'string' && typeof id === 'string') {
        return `<@&${id}> (${name})`
      }
      return null
    })
    .filter((item): item is string => item !== null)

  return roles.length === 0 ? '없음' : roles.join(', ')
}

const MAX_PERMISSION_NAMES = 12

/** 이전/이후 전체 목록 대신 실제로 바뀐 권한만 +/−로 보여준다. */
function formatPermissionDiff(oldValue: unknown, newValue: unknown): string {
  const oldBits = toPermissionBits(oldValue)
  const newBits = toPermissionBits(newValue)
  const added = newBits & ~oldBits
  const removed = oldBits & ~newBits

  const parts: string[] = []
  if (added !== 0n) parts.push(`✅ 허용: ${listPermissionNames(added)}`)
  if (removed !== 0n) parts.push(`⛔ 해제: ${listPermissionNames(removed)}`)

  if (parts.length === 0) return '변경 없음'
  return parts.join('\n')
}

function toPermissionBits(value: unknown): bigint {
  if (value === null || value === undefined) return 0n
  try {
    if (typeof value === 'bigint') return value
    if (typeof value === 'string' || typeof value === 'number') {
      return BigInt(value)
    }
    return 0n
  } catch {
    return 0n
  }
}

function listPermissionNames(bits: bigint): string {
  const labels: string[] = []
  const seenBits = new Set<bigint>()
  for (const [name, bit] of Object.entries(PermissionFlagsBits)) {
    const bitValue = BigInt(bit)
    if (seenBits.has(bitValue)) continue
    if ((bits & bitValue) === bitValue && bitValue !== 0n) {
      seenBits.add(bitValue)
      labels.push(translatePermission(name))
    }
  }

  if (labels.length === 0) return '없음'
  return (
    labels.slice(0, MAX_PERMISSION_NAMES).join(', ') +
    (labels.length > MAX_PERMISSION_NAMES
      ? ` 외 ${labels.length - MAX_PERMISSION_NAMES}개`
      : '')
  )
}

function translatePermission(name: string): string {
  const map: Readonly<Record<string, string>> = {
    AddReactions: '반응 추가',
    Administrator: '관리자',
    AttachFiles: '파일 첨부',
    BanMembers: '멤버 차단',
    ChangeNickname: '별명 변경',
    Connect: '음성 참가',
    CreateEvents: '이벤트 만들기',
    CreateGuildExpressions: '표현 요소 만들기',
    CreateInstantInvite: '초대 만들기',
    CreatePrivateThreads: '비공개 스레드 만들기',
    CreatePublicThreads: '공개 스레드 만들기',
    DeafenMembers: '멤버 청각 차단',
    EmbedLinks: '링크 첨부',
    KickMembers: '멤버 추방',
    ManageChannels: '채널 관리',
    ManageEmojisAndStickers: '이모지/스티커 관리',
    ManageEvents: '이벤트 관리',
    ManageGuild: '서버 관리',
    ManageGuildExpressions: '표현 요소 관리',
    ManageMessages: '메시지 관리',
    ManageNicknames: '별명 관리',
    ManageRoles: '역할 관리',
    ManageThreads: '스레드 관리',
    ManageWebhooks: '웹훅 관리',
    MentionEveryone: '@everyone 멘션',
    ModerateMembers: '멤버 타임아웃',
    MoveMembers: '멤버 이동',
    MuteMembers: '멤버 음소거',
    PrioritySpeaker: '우선 발언권',
    ReadMessageHistory: '이전 메시지 읽기',
    RequestToSpeak: '발언권 요청',
    SendMessages: '메시지 보내기',
    SendMessagesInThreads: '스레드에서 메시지 보내기',
    SendPolls: '설문 만들기',
    SendTTSMessages: 'TTS 메시지 보내기',
    SendVoiceMessages: '음성 메시지 보내기',
    Speak: '말하기',
    Stream: '방송하기',
    UseApplicationCommands: '앱 명령어 사용',
    UseEmbeddedActivities: '액티비티 사용',
    UseExternalApps: '외부 앱 사용',
    UseExternalEmojis: '외부 이모지 사용',
    UseExternalSounds: '외부 사운드 사용',
    UseExternalStickers: '외부 스티커 사용',
    UseSoundboard: '사운드보드 사용',
    UseVAD: '음성 감지 사용',
    ViewAuditLog: '감사 로그 보기',
    ViewChannel: '채널 보기',
    ViewCreatorMonetizationAnalytics: '수익화 분석 보기',
    ViewGuildInsights: '서버 인사이트 보기',
  }
  return map[name] ?? name
}

function formatIsoTimestamp(value: unknown): string {
  if (value === null || value === undefined) return '해제'
  if (typeof value !== 'string') return String(value)
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return value
  return `<t:${Math.floor(ms / 1000)}:F>`
}

function formatColor(value: unknown): string {
  if (value === null || value === undefined) return '기본'
  const num = asNumber(value)
  if (num === 0) return '기본'
  return `#${num.toString(16).padStart(6, '0')}`
}

function formatBoolean(value: unknown): string {
  if (value === true) return '켜짐'
  if (value === false) return '꺼짐'
  return '알 수 없음'
}

function formatBitrate(value: unknown): string {
  const num = asNumber(value)
  if (num === 0) return '기본'
  return `${(num / 1000).toFixed(1)}kbps`
}

function formatDuration(value: unknown): string {
  const seconds = asNumber(value)
  if (seconds === 0) return '무제한'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분`
  return `${Math.floor(seconds / 3600)}시간`
}

function formatMinutes(value: unknown): string {
  const seconds = asNumber(value)
  if (seconds === 0) return '없음'
  if (seconds % 60 === 0) return `${seconds / 60}분`
  return `${seconds}초`
}

function formatSlowmode(value: unknown): string {
  const seconds = asNumber(value)
  if (seconds === 0) return '없음'
  return `${seconds}초`
}

function formatNumber(value: unknown): string {
  if (value === null || value === undefined) return '0'
  if (value === 0) return '0'
  return String(value)
}

function formatIdReference(value: unknown, guild: Guild | undefined): string {
  if (value === null || value === undefined) return '없음'
  if (typeof value !== 'string') return String(value)

  if (guild !== undefined) {
    const channel = guild.channels.cache.get(value)
    if (channel !== undefined) return `<#${value}>`
    const role = guild.roles.cache.get(value)
    if (role !== undefined) return `<@&${value}>`
    const member = guild.members.cache.get(value)
    if (member !== undefined) return `<@${value}>`
  }

  return value
}

function formatIdReferenceList(
  value: unknown,
  guild: Guild | undefined
): string {
  if (!Array.isArray(value)) return formatGenericType(value)
  if (value.length === 0) return '없음'
  return value
    .slice(0, 10)
    .map((item) => formatIdReference(item, guild))
    .join(', ')
}

function formatStringList(value: unknown): string {
  if (!Array.isArray(value)) return formatGenericType(value)
  if (value.length === 0) return '없음'
  const items = value.filter((item): item is string => typeof item === 'string')
  const shown = items.slice(0, 10).join(', ')
  return items.length > 10 ? `${shown} 외 ${items.length - 10}개` : shown
}

function formatGenericType(value: unknown): string {
  if (value === null || value === undefined) return '없음'
  if (typeof value === 'string') return value.length === 0 ? '빈 값' : value
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (Array.isArray(value)) return `[${value.length}개 항목]`
  if (isRecord(value)) {
    const name = value['name']
    if (typeof name === 'string' && name.length > 0) return name
    const id = value['id']
    if (typeof id === 'string') return id
    return '객체'
  }
  return String(value)
}

function isNumeric(value: unknown): boolean {
  return typeof value === 'number'
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value) || 0
  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
