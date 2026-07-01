import { getSupabase } from '../ai/supabase'

export type LevelTrack = 'text' | 'voice'

export type TextActivityInput = {
  readonly guildId: string
  readonly now: Date
  readonly userId: string
}

export type VoiceSessionInput = {
  readonly channelId: string
  readonly endedAt: Date
  readonly guildId: string
  readonly startedAt: Date
  readonly userId: string
}

export type ActivityLevelStats = {
  readonly level: number
  readonly xp: number
  readonly xpNeeded: number
  readonly xpRemaining: number
}

export type TextLevelStats = ActivityLevelStats & {
  readonly messageCount: number
}

export type VoiceLevelStats = ActivityLevelStats & {
  readonly sessionCount: number
  readonly totalSeconds: number
}

export type CombinedLevelStats = {
  readonly text: TextLevelStats
  readonly voice: VoiceLevelStats
}

export type LevelRankingEntry = {
  readonly level: number
  readonly metric: number
  readonly userId: string
  readonly xp: number
}

export type ActivityLevelService = {
  readonly getRanking: (
    guildId: string,
    track: LevelTrack,
    limit?: number
  ) => Promise<readonly LevelRankingEntry[]>
  readonly getStats: (
    guildId: string,
    userId: string
  ) => Promise<CombinedLevelStats>
  readonly recordTextActivity: (input: TextActivityInput) => Promise<void>
  readonly recordVoiceSession: (input: VoiceSessionInput) => Promise<void>
}

const textXpPerMessage = 15
const textCooldownMs = 60_000
const voiceXpPerMinute = 10

function xpNeededForLevel(level: number): number {
  return level * level * 300
}

function normalizeStats(level: number, xp: number): ActivityLevelStats {
  const xpNeeded = xpNeededForLevel(level)
  return {
    level,
    xp,
    xpNeeded,
    xpRemaining: Math.max(0, xpNeeded - xp),
  }
}

function defaultTextStats(): TextLevelStats {
  return { ...normalizeStats(1, 0), messageCount: 0 }
}

function defaultVoiceStats(): VoiceLevelStats {
  return { ...normalizeStats(1, 0), sessionCount: 0, totalSeconds: 0 }
}

function voiceXpForDuration(durationSeconds: number): number {
  return Math.floor(durationSeconds / 60) * voiceXpPerMinute
}

export function createActivityLevelService(): ActivityLevelService {
  const textCooldowns = new Map<string, number>()

  async function recordTextActivity(input: TextActivityInput): Promise<void> {
    const cooldownKey = `${input.guildId}:${input.userId}`
    const previous = textCooldowns.get(cooldownKey) ?? 0
    if (input.now.getTime() - previous < textCooldownMs) return
    textCooldowns.set(cooldownKey, input.now.getTime())

    const supabase = getSupabase()
    if (supabase === null) return

    const { error } = await supabase.rpc('record_guild_text_xp', {
      p_guild_id: input.guildId,
      p_user_id: input.userId,
      p_xp: textXpPerMessage,
    })

    if (error !== null) throw new Error(`서버 레벨 기록 실패: ${error.message}`)
  }

  async function recordVoiceSession(input: VoiceSessionInput): Promise<void> {
    const durationSeconds = Math.max(
      0,
      Math.floor((input.endedAt.getTime() - input.startedAt.getTime()) / 1000)
    )
    const xp = voiceXpForDuration(durationSeconds)
    if (durationSeconds <= 0) return

    const supabase = getSupabase()
    if (supabase === null) return

    const { error } = await supabase.rpc('record_guild_voice_xp', {
      p_channel_id: input.channelId,
      p_duration_seconds: durationSeconds,
      p_ended_at: input.endedAt.toISOString(),
      p_guild_id: input.guildId,
      p_started_at: input.startedAt.toISOString(),
      p_user_id: input.userId,
      p_xp: xp,
    })

    if (error !== null) throw new Error(`음성 레벨 기록 실패: ${error.message}`)
  }

  async function getStats(
    guildId: string,
    userId: string
  ): Promise<CombinedLevelStats> {
    const supabase = getSupabase()
    if (supabase === null) {
      return { text: defaultTextStats(), voice: defaultVoiceStats() }
    }

    const [textResult, voiceResult] = await Promise.all([
      supabase
        .from('guild_text_levels')
        .select('level, xp, message_count')
        .eq('guild_id', guildId)
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('guild_voice_levels')
        .select('level, xp, total_seconds, session_count')
        .eq('guild_id', guildId)
        .eq('user_id', userId)
        .maybeSingle(),
    ])

    if (textResult.error !== null) {
      throw new Error(`서버 레벨 조회 실패: ${textResult.error.message}`)
    }
    if (voiceResult.error !== null) {
      throw new Error(`음성 레벨 조회 실패: ${voiceResult.error.message}`)
    }

    const textData = textResult.data
    const voiceData = voiceResult.data

    return {
      text:
        textData === null
          ? defaultTextStats()
          : {
              ...normalizeStats(
                Number(textData.level ?? 1),
                Number(textData.xp ?? 0)
              ),
              messageCount: Number(textData.message_count ?? 0),
            },
      voice:
        voiceData === null
          ? defaultVoiceStats()
          : {
              ...normalizeStats(
                Number(voiceData.level ?? 1),
                Number(voiceData.xp ?? 0)
              ),
              sessionCount: Number(voiceData.session_count ?? 0),
              totalSeconds: Number(voiceData.total_seconds ?? 0),
            },
    }
  }

  async function getRanking(
    guildId: string,
    track: LevelTrack,
    limit = 10
  ): Promise<readonly LevelRankingEntry[]> {
    const supabase = getSupabase()
    if (supabase === null) return []

    const safeLimit = Math.min(Math.max(limit, 1), 20)
    if (track === 'text') {
      const { data, error } = await supabase
        .from('guild_text_levels')
        .select('user_id, level, xp, message_count')
        .eq('guild_id', guildId)
        .order('xp', { ascending: false })
        .limit(safeLimit)

      if (error !== null)
        throw new Error(`레벨 랭킹 조회 실패: ${error.message}`)
      if (data === null) return []

      return data.map((row) => ({
        level: Number(row.level ?? 1),
        metric: Number(row.message_count ?? 0),
        userId: String(row.user_id ?? ''),
        xp: Number(row.xp ?? 0),
      }))
    }

    const { data, error } = await supabase
      .from('guild_voice_levels')
      .select('user_id, level, xp, total_seconds')
      .eq('guild_id', guildId)
      .order('xp', { ascending: false })
      .limit(safeLimit)

    if (error !== null) throw new Error(`레벨 랭킹 조회 실패: ${error.message}`)
    if (data === null) return []

    return data.map((row) => ({
      level: Number(row.level ?? 1),
      metric: Number(row.total_seconds ?? 0),
      userId: String(row.user_id ?? ''),
      xp: Number(row.xp ?? 0),
    }))
  }

  return {
    getRanking,
    getStats,
    recordTextActivity,
    recordVoiceSession,
  }
}
