import { logger } from '../../utils/logger'
import { getSupabase } from '../ai/supabase'
import {
  type FilterSeverity,
  MODERATION_GUILD_ID,
  MODERATION_IMMUNE_ROLE_IDS,
  type ModerationCategory,
} from './moderationConfig'

const SETTINGS_TABLE = 'moderation_settings'

export type ModerationSettings = {
  readonly guild_id: string
  readonly enabled: boolean
  readonly disabled_categories: readonly string[]
  readonly exempt_channels: readonly string[]
  readonly immune_roles: readonly string[]
  readonly min_severity: FilterSeverity
  readonly timeout_enabled: boolean
}

// 명시적으로 설정된 길드만 캐시에 담는다. 미설정 길드는 defaultRow를 따르며,
// 기본값은 MODERATION_GUILD_ID만 활성화(기존 하드코딩 동작 유지)이다.
const cache = new Map<string, ModerationSettings>()

function defaultRow(guildId: string): ModerationSettings {
  return {
    disabled_categories: [],
    enabled: guildId === MODERATION_GUILD_ID,
    exempt_channels: [],
    guild_id: guildId,
    immune_roles: [],
    min_severity: 'low',
    timeout_enabled: true,
  }
}

function getRow(guildId: string): ModerationSettings {
  return cache.get(guildId) ?? defaultRow(guildId)
}

function normalizeSeverity(value: unknown): FilterSeverity {
  return value === 'high' || value === 'medium' ? value : 'low'
}

export async function loadModerationSettings(): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) {
    logger.warn('Moderation', 'Supabase 미설정 - 검열 설정은 기본값 사용')
    return
  }

  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .select(
      'guild_id, enabled, disabled_categories, exempt_channels, immune_roles, min_severity, timeout_enabled'
    )

  if (error !== null) {
    logger.error('Moderation', `검열 설정 로드 실패: ${error.message}`)
    return
  }

  if (data !== null) {
    for (const row of data) {
      cache.set(row.guild_id, {
        disabled_categories: row.disabled_categories ?? [],
        enabled: row.enabled === true,
        exempt_channels: row.exempt_channels ?? [],
        guild_id: row.guild_id,
        immune_roles: row.immune_roles ?? [],
        min_severity: normalizeSeverity(row.min_severity),
        timeout_enabled: row.timeout_enabled !== false,
      })
    }
    logger.info('Moderation', `${data.length}개 길드 검열 설정 로드 완료`)
  }
}

async function persist(row: ModerationSettings): Promise<void> {
  cache.set(row.guild_id, row)

  const supabase = getSupabase()
  if (supabase === null) return

  const { error } = await supabase
    .from(SETTINGS_TABLE)
    .upsert(row, { onConflict: 'guild_id' })

  if (error !== null) {
    logger.error('Moderation', `검열 설정 저장 실패: ${error.message}`)
  }
}

// ---- 조회 ----

export function getModerationSettings(guildId: string): ModerationSettings {
  return getRow(guildId)
}

export function isModerationEnabled(guildId: string): boolean {
  return getRow(guildId).enabled
}

export function isCategoryEnabled(
  guildId: string,
  category: ModerationCategory
): boolean {
  return !getRow(guildId).disabled_categories.includes(category)
}

export function isChannelExempt(guildId: string, channelId: string): boolean {
  return getRow(guildId).exempt_channels.includes(channelId)
}

export function getEffectiveImmuneRoles(guildId: string): readonly string[] {
  const custom = getRow(guildId).immune_roles
  return custom.length > 0 ? custom : MODERATION_IMMUNE_ROLE_IDS
}

export function getMinSeverity(guildId: string): FilterSeverity {
  return getRow(guildId).min_severity
}

export function isTimeoutEnabled(guildId: string): boolean {
  return getRow(guildId).timeout_enabled
}

// ---- 변경 ----

export async function setModerationEnabled(
  guildId: string,
  enabled: boolean
): Promise<void> {
  await persist({ ...getRow(guildId), enabled })
}

export async function setCategoryEnabled(
  guildId: string,
  category: ModerationCategory,
  enabled: boolean
): Promise<void> {
  const row = getRow(guildId)
  const next = new Set(row.disabled_categories)
  if (enabled) next.delete(category)
  else next.add(category)
  await persist({ ...row, disabled_categories: [...next] })
}

export async function setChannelExempt(
  guildId: string,
  channelId: string,
  exempt: boolean
): Promise<void> {
  const row = getRow(guildId)
  const next = new Set(row.exempt_channels)
  if (exempt) next.add(channelId)
  else next.delete(channelId)
  await persist({ ...row, exempt_channels: [...next] })
}

export async function setImmuneRole(
  guildId: string,
  roleId: string,
  immune: boolean
): Promise<void> {
  const row = getRow(guildId)
  const next = new Set(row.immune_roles)
  if (immune) next.add(roleId)
  else next.delete(roleId)
  await persist({ ...row, immune_roles: [...next] })
}

export async function setSeverityAndTimeout(
  guildId: string,
  minSeverity: FilterSeverity,
  timeoutEnabled: boolean
): Promise<void> {
  await persist({
    ...getRow(guildId),
    min_severity: minSeverity,
    timeout_enabled: timeoutEnabled,
  })
}
