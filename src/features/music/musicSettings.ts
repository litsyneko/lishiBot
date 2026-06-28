import { getSupabase } from '../ai/supabase'

export type RepeatMode = 'off' | 'track' | 'queue'
export type ControllerTab = 'playback' | 'settings'

export type MusicSettings = {
  readonly djChannelId: string | null
  readonly volume: number | null
  readonly repeatMode: RepeatMode | null
  readonly controllerTab: ControllerTab | null
  readonly queueVisible: boolean | null
}

export type MusicSettingsService = {
  readonly ensureTableSchema: () => Promise<void>
  readonly getSettings: (
    guildId: string,
    botId?: string
  ) => Promise<MusicSettings>
  readonly patchSettings: (
    guildId: string,
    patch: Partial<MusicSettings>,
    botId?: string
  ) => Promise<void>
  readonly getDjChannelId: (
    guildId: string,
    botId?: string
  ) => Promise<string | null>
  readonly setDjChannelId: (
    guildId: string,
    channelId: string | null,
    botId?: string
  ) => Promise<void>
}

const DEFAULT_BOT_ID = 'main'
const DEFAULT_SETTINGS: MusicSettings = {
  djChannelId: null,
  volume: null,
  repeatMode: null,
  controllerTab: null,
  queueVisible: null,
}

function isRepeatMode(value: string | null | undefined): value is RepeatMode {
  return value === 'off' || value === 'track' || value === 'queue'
}

function isControllerTab(
  value: string | null | undefined
): value is ControllerTab {
  return value === 'playback' || value === 'settings'
}

export function createMusicSettingsService(): MusicSettingsService {
  async function ensureTableSchema(): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const sql = [
      'ALTER TABLE public.music_settings',
      'ADD COLUMN IF NOT EXISTS volume INTEGER,',
      'ADD COLUMN IF NOT EXISTS repeat_mode TEXT,',
      'ADD COLUMN IF NOT EXISTS controller_tab TEXT,',
      'ADD COLUMN IF NOT EXISTS queue_visible BOOLEAN;',
    ].join(' ')

    const { error } = await supabase.rpc('exec_sql', { sql })
    if (error !== null) {
      throw new Error(
        `스키마 마이그레이션 실패: ${error.message}\n실행 SQL: ${sql}`
      )
    }
  }

  async function getSettings(
    guildId: string,
    botId: string = DEFAULT_BOT_ID
  ): Promise<MusicSettings> {
    const supabase = getSupabase()
    if (supabase === null) return DEFAULT_SETTINGS

    const { data } = await supabase
      .from('music_settings')
      .select(
        'dj_channel_id, volume, repeat_mode, controller_tab, queue_visible'
      )
      .eq('guild_id', guildId)
      .eq('bot_id', botId)
      .maybeSingle()

    if (data === null || data === undefined) {
      return DEFAULT_SETTINGS
    }

    return {
      djChannelId: data.dj_channel_id ?? null,
      volume: typeof data.volume === 'number' ? data.volume : null,
      repeatMode: isRepeatMode(data.repeat_mode) ? data.repeat_mode : null,
      controllerTab: isControllerTab(data.controller_tab)
        ? data.controller_tab
        : null,
      queueVisible:
        typeof data.queue_visible === 'boolean' ? data.queue_visible : null,
    }
  }

  async function patchSettings(
    guildId: string,
    patch: Partial<MusicSettings>,
    botId: string = DEFAULT_BOT_ID
  ): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const row: Record<string, unknown> = {
      guild_id: guildId,
      bot_id: botId,
    }
    if ('djChannelId' in patch) row.dj_channel_id = patch.djChannelId
    if ('volume' in patch) row.volume = patch.volume
    if ('repeatMode' in patch) row.repeat_mode = patch.repeatMode
    if ('controllerTab' in patch) row.controller_tab = patch.controllerTab
    if ('queueVisible' in patch) row.queue_visible = patch.queueVisible

    const { error } = await supabase
      .from('music_settings')
      .upsert(row, { onConflict: 'guild_id,bot_id' })

    if (error !== null) throw new Error(`음악 설정 저장 실패: ${error.message}`)
  }

  async function getDjChannelId(
    guildId: string,
    botId: string = DEFAULT_BOT_ID
  ): Promise<string | null> {
    const settings = await getSettings(guildId, botId)
    return settings.djChannelId
  }

  async function setDjChannelId(
    guildId: string,
    channelId: string | null,
    botId: string = DEFAULT_BOT_ID
  ): Promise<void> {
    await patchSettings(guildId, { djChannelId: channelId }, botId)
  }

  return {
    ensureTableSchema,
    getSettings,
    patchSettings,
    getDjChannelId,
    setDjChannelId,
  }
}
