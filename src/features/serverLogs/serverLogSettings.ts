import { logger } from '../../utils/logger'
import { getSupabase } from '../ai/supabase'
import {
  SERVER_LOG_CATEGORIES,
  type ServerLogCategory,
  isServerLogCategory,
} from './serverLogCategories'

const SETTINGS_TABLE = 'server_log_settings'

export type CategoryChannelMap = Record<ServerLogCategory, string | null>

export type ServerLogExclusions = {
  readonly channels: readonly string[]
  readonly users: readonly string[]
  readonly roles: readonly string[]
}

export type ServerLogSettings = {
  readonly categoryChannels: CategoryChannelMap
  readonly enabled: boolean
  readonly exclusions: ServerLogExclusions
}

export type ServerLogSettingsPatch = {
  readonly categoryChannels?: Partial<CategoryChannelMap>
  readonly enabled?: boolean
  readonly exclusions?: Partial<ServerLogExclusions>
}

const SETTINGS_COLUMNS = 'guild_id, enabled, category_channels, exclusions'

const committedCache = new Map<string, ServerLogSettings>()
const draftCache = new Map<string, ServerLogSettings>()

export function getDefaultServerLogSettings(): ServerLogSettings {
  return {
    categoryChannels: emptyCategoryChannels(),
    enabled: false,
    exclusions: emptyExclusions(),
  }
}

export async function loadServerLogSettings(): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) {
    logger.warn(
      'ServerLog',
      'Supabase 미설정 - 관리 로그 설정은 메모리에만 보관'
    )
    return
  }

  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .select(SETTINGS_COLUMNS)

  if (error !== null) {
    logger.error('ServerLog', `설정 로드 실패: ${error.message}`)
    return
  }

  if (data === null) return

  for (const row of data) {
    committedCache.set(row.guild_id, parseSettingsRow(row))
  }
  logger.info('ServerLog', `${data.length}개 길드 로그 설정 로드 완료`)
}

export async function getServerLogSettings(
  guildId: string
): Promise<ServerLogSettings> {
  const cached = committedCache.get(guildId)
  if (cached !== undefined) return cached

  const supabase = getSupabase()
  if (supabase === null) return getDefaultServerLogSettings()

  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .select(SETTINGS_COLUMNS)
    .eq('guild_id', guildId)
    .maybeSingle()

  if (error !== null) {
    logger.error('ServerLog', `설정 조회 실패: ${error.message}`)
    return getDefaultServerLogSettings()
  }

  // 행이 없는 길드도 캐시해 이벤트마다 DB를 조회하지 않는다.
  const settings =
    data === null ? getDefaultServerLogSettings() : parseSettingsRow(data)
  committedCache.set(guildId, settings)
  return settings
}

export function getDraftServerLogSettings(guildId: string): ServerLogSettings {
  const draft = draftCache.get(guildId)
  if (draft !== undefined) return draft
  const committed = committedCache.get(guildId)
  if (committed !== undefined) return committed
  return getDefaultServerLogSettings()
}

export function hasDraft(guildId: string): boolean {
  return draftCache.has(guildId)
}

export function updateDraft(
  guildId: string,
  patch: ServerLogSettingsPatch
): ServerLogSettings {
  const base = draftCache.get(guildId) ?? readCommittedOrDefault(guildId)
  const nextCategoryChannels =
    patch.categoryChannels !== undefined
      ? mergeCategoryChannels(base.categoryChannels, patch.categoryChannels)
      : base.categoryChannels
  const nextEnabled = patch.enabled !== undefined ? patch.enabled : base.enabled
  const nextExclusions =
    patch.exclusions !== undefined
      ? { ...base.exclusions, ...patch.exclusions }
      : base.exclusions

  const next: ServerLogSettings = {
    categoryChannels: nextCategoryChannels,
    enabled: nextEnabled,
    exclusions: nextExclusions,
  }
  draftCache.set(guildId, next)
  return next
}

export async function commitDraft(guildId: string): Promise<ServerLogSettings> {
  const draft = draftCache.get(guildId) ?? readCommittedOrDefault(guildId)
  committedCache.set(guildId, draft)
  draftCache.delete(guildId)

  const supabase = getSupabase()
  if (supabase !== null) {
    const { error } = await supabase.from(SETTINGS_TABLE).upsert(
      {
        category_channels: toStoredMap(draft.categoryChannels),
        enabled: draft.enabled,
        exclusions: toStoredExclusions(draft.exclusions),
        guild_id: guildId,
      },
      { onConflict: 'guild_id' }
    )

    if (error !== null) {
      logger.error('ServerLog', `설정 저장 실패: ${error.message}`)
    }
  }

  return draft
}

export function discardDraft(guildId: string): ServerLogSettings {
  draftCache.delete(guildId)
  return readCommittedOrDefault(guildId)
}

function readCommittedOrDefault(guildId: string): ServerLogSettings {
  return committedCache.get(guildId) ?? getDefaultServerLogSettings()
}

function parseSettingsRow(row: {
  readonly category_channels?: Record<string, string | null> | null
  readonly enabled?: boolean | null
  readonly exclusions?: Record<string, unknown> | null
}): ServerLogSettings {
  return {
    categoryChannels: parseCategoryChannels(row.category_channels),
    enabled: row.enabled === true,
    exclusions: parseExclusions(row.exclusions),
  }
}

function emptyCategoryChannels(): CategoryChannelMap {
  return SERVER_LOG_CATEGORIES.reduce((acc, category) => {
    acc[category] = null
    return acc
  }, {} as Record<ServerLogCategory, string | null>)
}

export function emptyExclusions(): ServerLogExclusions {
  return { channels: [], roles: [], users: [] }
}

function parseCategoryChannels(
  raw: Record<string, string | null> | null | undefined
): CategoryChannelMap {
  const result = emptyCategoryChannels()
  if (raw === null || raw === undefined) return result

  for (const key of Object.keys(raw)) {
    if (!isServerLogCategory(key)) continue
    const value = raw[key]
    if (typeof value === 'string' && value.length > 0) {
      result[key] = value
    }
  }

  return result
}

function parseExclusions(
  raw: Record<string, unknown> | null | undefined
): ServerLogExclusions {
  if (raw === null || raw === undefined) return emptyExclusions()
  return {
    channels: parseIdList(raw['channels']),
    roles: parseIdList(raw['roles']),
    users: parseIdList(raw['users']),
  }
}

function parseIdList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0
  )
}

function mergeCategoryChannels(
  current: CategoryChannelMap,
  patch: Partial<CategoryChannelMap>
): CategoryChannelMap {
  return { ...current, ...patch }
}

function toStoredMap(map: CategoryChannelMap): Record<string, string | null> {
  return { ...map }
}

function toStoredExclusions(
  exclusions: ServerLogExclusions
): Record<string, readonly string[]> {
  return {
    channels: exclusions.channels,
    roles: exclusions.roles,
    users: exclusions.users,
  }
}
