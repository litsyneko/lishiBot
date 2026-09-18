import { logger } from '../../utils/logger'
import { getSupabase } from '../ai/supabase'

const SETTINGS_TABLE = 'temp_voice_settings'
const SETTINGS_COLUMNS =
  'guild_id, enabled, generator_channel_id, category_id, name_template, default_user_limit, owner_grace_minutes, cooldown_seconds, log_channel_id'

export const DEFAULT_NAME_TEMPLATE = '{user}의 통화방'
export const OWNER_GRACE_CHOICES = [0, 10, 20, 30] as const

export type TempVoiceSettings = {
  readonly enabled: boolean
  readonly generatorChannelId: string | null
  readonly categoryId: string | null
  readonly nameTemplate: string
  readonly defaultUserLimit: number
  readonly ownerGraceMinutes: number
  readonly cooldownSeconds: number
  readonly logChannelId: string | null
}

export type TempVoiceSettingsPatch = {
  readonly enabled?: boolean
  readonly generatorChannelId?: string | null
  readonly categoryId?: string | null
  readonly nameTemplate?: string
  readonly defaultUserLimit?: number
  readonly ownerGraceMinutes?: number
  readonly cooldownSeconds?: number
  readonly logChannelId?: string | null
}

const committedCache = new Map<string, TempVoiceSettings>()
const draftCache = new Map<string, TempVoiceSettings>()

export function getDefaultTempVoiceSettings(): TempVoiceSettings {
  return {
    enabled: false,
    generatorChannelId: null,
    categoryId: null,
    nameTemplate: DEFAULT_NAME_TEMPLATE,
    defaultUserLimit: 0,
    ownerGraceMinutes: 10,
    cooldownSeconds: 30,
    logChannelId: null,
  }
}

export async function loadTempVoiceSettings(): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) {
    logger.warn('TempVoice', 'Supabase 미설정 - 통화방 설정은 메모리에만 보관')
    return
  }

  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .select(SETTINGS_COLUMNS)

  if (error !== null) {
    logger.error('TempVoice', `설정 로드 실패: ${error.message}`)
    return
  }
  if (data === null) return

  for (const row of data) {
    committedCache.set(row.guild_id, parseSettingsRow(row))
  }
  logger.info('TempVoice', `${data.length}개 길드 통화방 설정 로드 완료`)
}

export async function getTempVoiceSettings(
  guildId: string
): Promise<TempVoiceSettings> {
  const cached = committedCache.get(guildId)
  if (cached !== undefined) return cached

  const supabase = getSupabase()
  if (supabase === null) return getDefaultTempVoiceSettings()

  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .select(SETTINGS_COLUMNS)
    .eq('guild_id', guildId)
    .maybeSingle()

  if (error !== null) {
    logger.error('TempVoice', `설정 조회 실패: ${error.message}`)
    return getDefaultTempVoiceSettings()
  }

  // 행이 없어도 캐시해 음성 이벤트마다 DB를 조회하지 않는다.
  const settings =
    data === null ? getDefaultTempVoiceSettings() : parseSettingsRow(data)
  committedCache.set(guildId, settings)
  return settings
}

/** 캐시에 이미 있는 설정만 즉시 반환(동기). 음성 이벤트 핫패스용. */
export function getCachedTempVoiceSettings(
  guildId: string
): TempVoiceSettings | null {
  return committedCache.get(guildId) ?? null
}

export function getDraftTempVoiceSettings(guildId: string): TempVoiceSettings {
  const draft = draftCache.get(guildId)
  if (draft !== undefined) return draft
  return readCommittedOrDefault(guildId)
}

export function hasDraft(guildId: string): boolean {
  return draftCache.has(guildId)
}

export function updateDraft(
  guildId: string,
  patch: TempVoiceSettingsPatch
): TempVoiceSettings {
  const base = draftCache.get(guildId) ?? readCommittedOrDefault(guildId)
  const next = mergeTempVoiceSettings(base, patch)
  draftCache.set(guildId, next)
  return next
}

export async function commitDraft(guildId: string): Promise<TempVoiceSettings> {
  const draft = draftCache.get(guildId) ?? readCommittedOrDefault(guildId)
  committedCache.set(guildId, draft)
  draftCache.delete(guildId)
  await persistTempVoiceSettings(guildId, draft)
  return draft
}

/**
 * 드래프트 흐름을 거치지 않고 설정을 즉시 반영한다(AI 도구 등 프로그램 경로용).
 * committed 캐시와 DB에 곧바로 upsert한다.
 */
export async function applyTempVoiceSettings(
  guildId: string,
  patch: TempVoiceSettingsPatch
): Promise<TempVoiceSettings> {
  const base = committedCache.get(guildId) ?? getDefaultTempVoiceSettings()
  const next = mergeTempVoiceSettings(base, patch)
  committedCache.set(guildId, next)
  await persistTempVoiceSettings(guildId, next)
  return next
}

function mergeTempVoiceSettings(
  base: TempVoiceSettings,
  patch: TempVoiceSettingsPatch
): TempVoiceSettings {
  return {
    enabled: patch.enabled ?? base.enabled,
    generatorChannelId:
      patch.generatorChannelId !== undefined
        ? patch.generatorChannelId
        : base.generatorChannelId,
    categoryId:
      patch.categoryId !== undefined ? patch.categoryId : base.categoryId,
    nameTemplate: patch.nameTemplate ?? base.nameTemplate,
    defaultUserLimit: patch.defaultUserLimit ?? base.defaultUserLimit,
    ownerGraceMinutes: patch.ownerGraceMinutes ?? base.ownerGraceMinutes,
    cooldownSeconds: patch.cooldownSeconds ?? base.cooldownSeconds,
    logChannelId:
      patch.logChannelId !== undefined ? patch.logChannelId : base.logChannelId,
  }
}

async function persistTempVoiceSettings(
  guildId: string,
  settings: TempVoiceSettings
): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) return

  const { error } = await supabase.from(SETTINGS_TABLE).upsert(
    {
      guild_id: guildId,
      enabled: settings.enabled,
      generator_channel_id: settings.generatorChannelId,
      category_id: settings.categoryId,
      name_template: settings.nameTemplate,
      default_user_limit: settings.defaultUserLimit,
      owner_grace_minutes: settings.ownerGraceMinutes,
      cooldown_seconds: settings.cooldownSeconds,
      log_channel_id: settings.logChannelId,
    },
    { onConflict: 'guild_id' }
  )
  if (error !== null) {
    logger.error('TempVoice', `설정 저장 실패: ${error.message}`)
  }
}

export function discardDraft(guildId: string): TempVoiceSettings {
  draftCache.delete(guildId)
  return readCommittedOrDefault(guildId)
}

function readCommittedOrDefault(guildId: string): TempVoiceSettings {
  return committedCache.get(guildId) ?? getDefaultTempVoiceSettings()
}

function parseSettingsRow(row: {
  readonly enabled?: boolean | null
  readonly generator_channel_id?: string | null
  readonly category_id?: string | null
  readonly name_template?: string | null
  readonly default_user_limit?: number | null
  readonly owner_grace_minutes?: number | null
  readonly cooldown_seconds?: number | null
  readonly log_channel_id?: string | null
}): TempVoiceSettings {
  const template =
    typeof row.name_template === 'string' && row.name_template.trim().length > 0
      ? row.name_template
      : DEFAULT_NAME_TEMPLATE
  return {
    enabled: row.enabled === true,
    generatorChannelId: nonEmpty(row.generator_channel_id),
    categoryId: nonEmpty(row.category_id),
    nameTemplate: template,
    defaultUserLimit: clampInt(row.default_user_limit, 0, 0, 99),
    ownerGraceMinutes: clampInt(row.owner_grace_minutes, 10, 0, 120),
    cooldownSeconds: clampInt(row.cooldown_seconds, 30, 0, 600),
    logChannelId: nonEmpty(row.log_channel_id),
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function clampInt(
  value: number | null | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}
