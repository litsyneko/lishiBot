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
  afk_channel_id: 'AFK 채널',
  afk_timeout: 'AFK 타임아웃',
  allow: '허용 권한',
  application_id: '애플리케이션',
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
  default_message_notifications: '기본 알림 설정',
  default_reaction_emoji: '기본 반응 이모지',
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
  inviter_id: '초대자',
  location: '위치',
  locked: '잠금',
  max_age: '최대 기간',
  max_uses: '최대 사용 횟수',
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
  privacy_level: '공개 범위',
  prune_delete_days: '프룬 삭제 일수',
  public_updates_channel_id: '업데이트 채널',
  rate_limit_per_user: '슬로우모드',
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
    return `${formatPermissionBits(oldValue)} -> ${formatPermissionBits(
      newValue
    )}`
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

  if (key === 'color') {
    return `${formatColor(oldValue)} -> ${formatColor(newValue)}`
  }

  if (
    key === 'hoist' ||
    key === 'mentionable' ||
    key === 'nsfw' ||
    key === 'temporary' ||
    key === 'locked' ||
    key === 'archived' ||
    key === 'available' ||
    key === 'enabled' ||
    key === 'deaf' ||
    key === 'mute' ||
    key === 'widget_enabled'
  ) {
    return `${formatBoolean(oldValue)} -> ${formatBoolean(newValue)}`
  }

  if (key === 'position') {
    return `${asNumber(oldValue) + 1}번 -> ${asNumber(newValue) + 1}번`
  }

  if (key === 'bitrate') {
    return `${formatBitrate(oldValue)} -> ${formatBitrate(newValue)}`
  }

  if (key === 'afk_timeout') {
    return `${asNumber(oldValue)}초 -> ${asNumber(newValue)}초`
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

  if (
    key === 'channel_id' ||
    key === 'afk_channel_id' ||
    key === 'rules_channel_id' ||
    key === 'system_channel_id' ||
    key === 'public_updates_channel_id' ||
    key === 'safety_alerts_channel_id' ||
    key === 'widget_channel_id' ||
    key === 'application_id' ||
    key === 'inviter_id' ||
    key === 'owner_id' ||
    key === 'user_id' ||
    key === 'guild_id' ||
    key === 'sound_id' ||
    key === 'emoji_id'
  ) {
    return `${formatIdReference(oldValue, guild)} -> ${formatIdReference(
      newValue,
      guild
    )}`
  }

  if (key === 'type') {
    return `${formatGenericType(oldValue)} -> ${formatGenericType(newValue)}`
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

function formatPermissionBits(value: unknown): string {
  if (value === null || value === undefined) return '없음'
  const bits =
    typeof value === 'string' ? BigInt(value) : BigInt(asNumber(value))
  if (bits === 0n) return '없음'

  const labels: string[] = []
  for (const [name, bit] of Object.entries(PermissionFlagsBits)) {
    if ((bits & BigInt(bit)) === BigInt(bit)) {
      labels.push(translatePermission(name))
    }
  }

  return labels.length === 0
    ? '없음'
    : labels.slice(0, 5).join(', ') +
        (labels.length > 5 ? ` 외 ${labels.length - 5}개` : '')
}

function translatePermission(name: string): string {
  const map: Readonly<Record<string, string>> = {
    Administrator: '관리자',
    ManageGuild: '서버 관리',
    ManageChannels: '채널 관리',
    ManageRoles: '역할 관리',
    ManageMessages: '메시지 관리',
    KickMembers: '킥',
    BanMembers: '밴',
    ManageWebhooks: '웹훅 관리',
    ManageNicknames: '별명 관리',
    ManageEmojisAndStickers: '이모지/스티커 관리',
    ViewAudit_log: '감사 로그 보기',
    ViewChannel: '채널 보기',
    SendMessages: '메시지 보내기',
    ReadMessageHistory: '이전 메시지 읽기',
    Connect: '음성 참가',
    Speak: '말하기',
    MuteMembers: '멤버 음소거',
    MoveMembers: '멤버 이동',
    ManageThreads: '스레드 관리',
    ModerateMembers: '멤버 관리',
  }
  return map[name] ?? name
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

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value) || 0
  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
