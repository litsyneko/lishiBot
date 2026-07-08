import { logger } from '../../utils/logger'
import { getSupabase } from './supabase'

// ── 타입 ──

export type ApprovalPolicy = {
  /** danger 도구 승인 주체. admin_only=관리자만, requester=요청자 본인, none=승인 불필요 */
  readonly dangerGate: 'admin_only' | 'requester' | 'none'
}

export type ServerProfile = {
  readonly guildId: string
  readonly concept: string | null
  readonly channelRoles: Record<string, string>
  readonly approvalPolicy: ApprovalPolicy
  readonly allowedUsers: string[]
  readonly agentScope: Record<string, unknown>
  readonly onboardedAt: Date | null
}

// ── 상수 ──

const TABLE = 'server_profile'
const CACHE_TTL_MS = 10 * 60 * 1000 // 10분

const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { dangerGate: 'admin_only' }

// ── 하드코딩 안전 기본값 (테이블 부재/프로필 없음 시 사용) ──
function defaultProfile(guildId: string): ServerProfile {
  return {
    guildId,
    concept: null,
    channelRoles: {},
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
    allowedUsers: [],
    agentScope: {},
    onboardedAt: null,
  }
}

// ── RAM 캐시 ──

type CacheEntry = {
  profile: ServerProfile
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

function getCached(guildId: string): ServerProfile | undefined {
  const entry = cache.get(guildId)
  if (entry === undefined) return undefined
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(guildId)
    return undefined
  }
  return entry.profile
}

function setCache(profile: ServerProfile): void {
  cache.set(profile.guildId, { profile, fetchedAt: Date.now() })
}

// ── DB 조회 ──

function parseApprovalPolicy(raw: unknown): ApprovalPolicy {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>
    const gate = obj.dangerGate
    if (gate === 'admin_only' || gate === 'requester' || gate === 'none') {
      return { dangerGate: gate }
    }
  }
  return DEFAULT_APPROVAL_POLICY
}

function parseAllowedUsers(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string')
  }
  return []
}

function rowToProfile(row: Record<string, unknown>): ServerProfile {
  return {
    guildId: row.guild_id as string,
    concept: (row.concept as string) ?? null,
    channelRoles:
      row.channel_roles !== null &&
      typeof row.channel_roles === 'object' &&
      !Array.isArray(row.channel_roles)
        ? (row.channel_roles as Record<string, string>)
        : {},
    approvalPolicy: parseApprovalPolicy(row.approval_policy),
    allowedUsers: parseAllowedUsers(row.allowed_users),
    agentScope:
      row.agent_scope !== null &&
      typeof row.agent_scope === 'object' &&
      !Array.isArray(row.agent_scope)
        ? (row.agent_scope as Record<string, unknown>)
        : {},
    onboardedAt:
      typeof row.onboarded_at === 'string' ? new Date(row.onboarded_at) : null,
  }
}

// ── 공개 API ──

/**
 * 서버 프로필을 반환한다. 캐시 → DB → 기본값 fallback 순.
 * DB 조회 실패 시에도 기본값을 반환하므로 절대 throw하지 않는다.
 */
export async function getServerProfile(
  guildId: string
): Promise<ServerProfile> {
  const cached = getCached(guildId)
  if (cached !== undefined) return cached

  const supabase = getSupabase()
  if (supabase === null) return defaultProfile(guildId)

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('guild_id', guildId)
      .maybeSingle()

    if (error !== null) {
      // 42P01 = 테이블 미존재 (마이그레이션 미적용)
      if ((error as { code?: string }).code === '42P01') {
        return defaultProfile(guildId)
      }
      logger.warn(
        'ServerProfile',
        `DB 조회 실패: ${error.message ?? 'unknown'}`
      )
      return defaultProfile(guildId)
    }

    if (data === null) {
      // 테이블은 있지만 이 길드의 프로필이 없음
      const profile = defaultProfile(guildId)
      setCache(profile)
      return profile
    }

    const profile = rowToProfile(data)
    setCache(profile)
    return profile
  } catch (err) {
    logger.warn(
      'ServerProfile',
      `프로필 로드 예외: ${err instanceof Error ? err.message : String(err)}`
    )
    return defaultProfile(guildId)
  }
}

/**
 * 서버 프로필을 upsert한다. 부분 업데이트 지원.
 * DB 실패 시 RAM 캐시만 갱신한다(fire-and-forget이 아닌 await).
 */
export async function upsertServerProfile(
  guildId: string,
  partial: Partial<
    Pick<
      ServerProfile,
      | 'concept'
      | 'channelRoles'
      | 'approvalPolicy'
      | 'allowedUsers'
      | 'agentScope'
      | 'onboardedAt'
    >
  >
): Promise<void> {
  // RAM 캐시 먼저 갱신
  const current = getCached(guildId) ?? defaultProfile(guildId)
  const updated: ServerProfile = {
    ...current,
    ...partial,
    guildId,
  }
  setCache(updated)

  const supabase = getSupabase()
  if (supabase === null) return

  const row: Record<string, unknown> = {
    guild_id: guildId,
    updated_at: new Date().toISOString(),
  }
  if (partial.concept !== undefined) row.concept = partial.concept
  if (partial.channelRoles !== undefined)
    row.channel_roles = partial.channelRoles
  if (partial.approvalPolicy !== undefined)
    row.approval_policy = partial.approvalPolicy
  if (partial.allowedUsers !== undefined)
    row.allowed_users = partial.allowedUsers
  if (partial.agentScope !== undefined) row.agent_scope = partial.agentScope
  if (partial.onboardedAt !== undefined)
    row.onboarded_at = partial.onboardedAt?.toISOString() ?? null

  try {
    const { error } = await supabase.from(TABLE).upsert(row, {
      onConflict: 'guild_id',
    })
    if (error !== null) {
      if ((error as { code?: string }).code === '42P01') return
      logger.warn(
        'ServerProfile',
        `프로필 upsert 실패: ${error.message ?? 'unknown'}`
      )
    }
  } catch (err) {
    logger.warn(
      'ServerProfile',
      `프로필 upsert 예외: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** RAM 캐시를 무효화한다. 다음 호출 시 DB에서 다시 로드. */
export function invalidateProfileCache(guildId: string): void {
  cache.delete(guildId)
}

// ── Standing Orders (상시 지침) ──
// 서버별 상시 지침. 새 컬럼 없이 agent_scope(JSONB)를 재사용해 저장한다.

const STANDING_ORDERS_KEY = 'standingOrders'

/** agent_scope에서 상시 지침 목록을 꺼낸다. */
export function getStandingOrders(profile: ServerProfile): string[] {
  const raw = profile.agentScope[STANDING_ORDERS_KEY]
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string')
  }
  return []
}

/** 상시 지침 목록을 저장한다(agent_scope 병합, 다른 scope 값 보존). */
export async function setStandingOrders(
  guildId: string,
  orders: string[]
): Promise<void> {
  const profile = await getServerProfile(guildId)
  await upsertServerProfile(guildId, {
    agentScope: { ...profile.agentScope, [STANDING_ORDERS_KEY]: orders },
  })
}

// ── 소울 (에이전트 정체성 — "내가 누구인지") ──
// OpenClaw의 SOUL.md에 해당. agent_scope(JSONB)에 저장해 새 컬럼 없이 영속.

const SOUL_KEY = 'soul'

/** agent_scope에서 소울(에이전트 정체성)을 꺼낸다. 없으면 null. */
export function getSoul(profile: ServerProfile): string | null {
  const raw = profile.agentScope[SOUL_KEY]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null
}

/** 소울을 저장한다(agent_scope 병합, 다른 scope 값 보존). null이면 삭제. */
export async function setSoul(
  guildId: string,
  soul: string | null
): Promise<void> {
  const profile = await getServerProfile(guildId)
  await upsertServerProfile(guildId, {
    agentScope: { ...profile.agentScope, [SOUL_KEY]: soul },
  })
}

/**
 * 서버 맥락(컨셉 + 이 채널 용도 + 상시 지침)을 프롬프트 블록으로 만든다.
 * 설정이 하나도 없으면 빈 문자열을 반환해 주입을 건너뛴다.
 */
export async function formatServerContextForPrompt(
  guildId: string,
  channelId: string
): Promise<string> {
  const profile = await getServerProfile(guildId)
  const lines: string[] = []
  const soul = getSoul(profile)
  if (soul !== null) {
    lines.push(`나의 소울(정체성): ${soul}`)
  }
  if (profile.concept !== null && profile.concept.trim().length > 0) {
    lines.push(`서버 컨셉: ${profile.concept}`)
  }
  const channelRole = profile.channelRoles[channelId]
  if (typeof channelRole === 'string' && channelRole.trim().length > 0) {
    lines.push(`이 채널 용도: ${channelRole}`)
  }
  const orders = getStandingOrders(profile)
  if (orders.length > 0) {
    lines.push('상시 지침(항상 지킬 것):')
    for (const order of orders) lines.push(`- ${order}`)
  }
  if (lines.length === 0) return ''
  return `[서버 설정]\n${lines.join('\n')}`
}

// ── 온보딩 거부 숨김 (2h/24h는 agent_scope에 영속, next_chat은 RAM) ──

const ONBOARDING_DISMISSED_KEY = 'onboardingDismissedUntil'

/** agent_scope에 저장된 온보딩 숨김 만료 시각(epoch ms). 없으면 null. */
export function getOnboardingDismissedUntil(
  profile: ServerProfile
): number | null {
  const raw = profile.agentScope[ONBOARDING_DISMISSED_KEY]
  return typeof raw === 'number' ? raw : null
}

/** 온보딩 숨김 만료 시각을 저장한다(agent_scope 병합, 다른 scope 값 보존). */
export async function setOnboardingDismissedUntil(
  guildId: string,
  until: number
): Promise<void> {
  const profile = await getServerProfile(guildId)
  await upsertServerProfile(guildId, {
    agentScope: { ...profile.agentScope, [ONBOARDING_DISMISSED_KEY]: until },
  })
}

// ── Heartbeat(자동 발화) 설정 — agent_scope에 저장, 기본 OFF ──

export type HeartbeatConfig = {
  readonly enabled: boolean
  readonly channelId: string | null
}

const HEARTBEAT_KEY = 'heartbeat'
const DEFAULT_HEARTBEAT: HeartbeatConfig = { enabled: false, channelId: null }

/** agent_scope에서 heartbeat 설정을 꺼낸다. 기본은 OFF(자동 발화 안 함). */
export function getHeartbeatConfig(profile: ServerProfile): HeartbeatConfig {
  const raw = profile.agentScope[HEARTBEAT_KEY]
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>
    return {
      enabled: obj.enabled === true,
      channelId: typeof obj.channelId === 'string' ? obj.channelId : null,
    }
  }
  return DEFAULT_HEARTBEAT
}

/** heartbeat 설정을 저장한다(agent_scope 병합, 다른 scope 값 보존). */
export async function setHeartbeatConfig(
  guildId: string,
  config: HeartbeatConfig
): Promise<void> {
  const profile = await getServerProfile(guildId)
  await upsertServerProfile(guildId, {
    agentScope: { ...profile.agentScope, [HEARTBEAT_KEY]: config },
  })
}
