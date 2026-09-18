import { getSupabase } from '../ai/supabase'
import {
  type LevelRankingEntry,
  type LevelTrack,
  createActivityLevelService,
} from './activityLevels'

export type StatsType = LevelTrack
export type StatsScope = 'personal' | 'guild'

export type UserStatsSummary = {
  readonly level: number
  readonly metric: number
  readonly percentile: number
  readonly rank: number
  readonly totalParticipants: number
  readonly xp: number
  readonly xpNeeded: number
  readonly xpRemaining: number
}

export type VoiceSessionRow = {
  readonly channelId: string
  readonly durationSeconds: number
  readonly endedAt: Date
  readonly startedAt: Date
  readonly xpAwarded: number
}

export type VoiceChannelBreakdown = {
  readonly channelId: string
  readonly sessionCount: number
  readonly totalSeconds: number
}

export type GuildAggregate = {
  readonly avgLevel: number
  readonly maxLevel: number
  readonly participantCount: number
  readonly totalMetric: number
  readonly totalSessions: number
  readonly totalXp: number
}

export type LevelBucket = {
  readonly count: number
  readonly label: string
  readonly maxLevel: number
  readonly minLevel: number
}

export type GuildStatsResult = {
  readonly aggregate: GuildAggregate
  readonly distribution: readonly LevelBucket[]
  readonly leaderboard: readonly LevelRankingEntry[]
  readonly voiceHourHistogram?: readonly number[]
}

export type PersonalStatsResult = {
  readonly channelBreakdown?: readonly VoiceChannelBreakdown[]
  readonly recentVoiceSessions?: readonly VoiceSessionRow[]
  readonly summary: UserStatsSummary
}

const distributionBuckets: readonly LevelBucket[] = [
  { label: '1-5', minLevel: 1, maxLevel: 5, count: 0 },
  { label: '6-10', minLevel: 6, maxLevel: 10, count: 0 },
  { label: '11-20', minLevel: 11, maxLevel: 20, count: 0 },
  { label: '21-40', minLevel: 21, maxLevel: 40, count: 0 },
  { label: '41+', minLevel: 41, maxLevel: Infinity, count: 0 },
]

const emptyAggregate: GuildAggregate = {
  avgLevel: 0,
  maxLevel: 0,
  participantCount: 0,
  totalMetric: 0,
  totalSessions: 0,
  totalXp: 0,
}

function num(value: unknown): number {
  return Number(value ?? 0)
}

function percentile(rank: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((1 - rank / total) * 100)))
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export async function getUserRank(
  guildId: string,
  track: StatsType,
  userId: string
): Promise<{ readonly rank: number; readonly totalParticipants: number }> {
  const supabase = getSupabase()
  if (supabase === null) return { rank: 1, totalParticipants: 0 }

  const table = track === 'text' ? 'guild_text_levels' : 'guild_voice_levels'
  const { data, error } = await supabase
    .from(table)
    .select('user_id, xp')
    .eq('guild_id', guildId)
    .order('xp', { ascending: false })
    .limit(200)

  if (error !== null) throw new Error(`통계 순위 조회 실패: ${error.message}`)
  if (data === null) return { rank: 1, totalParticipants: 0 }

  const totalParticipants = data.length
  const index = data.findIndex((row) => record(row) && row.user_id === userId)
  return {
    rank: index >= 0 ? index + 1 : totalParticipants + 1,
    totalParticipants,
  }
}

export async function getPersonalStats(
  guildId: string,
  userId: string,
  type: StatsType
): Promise<PersonalStatsResult> {
  const base = await createActivityLevelService().getStats(guildId, userId)
  const { rank, totalParticipants } = await getUserRank(guildId, type, userId)
  const summary: UserStatsSummary = {
    ...(type === 'text' ? base.text : base.voice),
    rank,
    totalParticipants,
    percentile: percentile(rank, totalParticipants),
    metric: type === 'text' ? base.text.messageCount : base.voice.totalSeconds,
  }

  if (type === 'text') return { summary }

  const supabase = getSupabase()
  if (supabase === null) return { summary }

  const { data, error } = await supabase
    .from('guild_voice_sessions')
    .select('channel_id, started_at, ended_at, duration_seconds, xp_awarded')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .order('started_at', { ascending: false })
    .limit(14)

  if (error !== null) throw new Error(`음성 세션 조회 실패: ${error.message}`)

  const recentVoiceSessions = (data ?? []).map((row) => ({
    channelId: String(row.channel_id),
    startedAt: new Date(row.started_at),
    endedAt: new Date(row.ended_at),
    durationSeconds: num(row.duration_seconds),
    xpAwarded: num(row.xp_awarded),
  }))

  const channelTotals: Record<string, { count: number; totalSeconds: number }> =
    {}
  for (const session of recentVoiceSessions) {
    const current = channelTotals[session.channelId] ?? {
      count: 0,
      totalSeconds: 0,
    }
    channelTotals[session.channelId] = {
      count: current.count + 1,
      totalSeconds: current.totalSeconds + session.durationSeconds,
    }
  }

  const channelBreakdown = Object.entries(channelTotals)
    .map(([channelId, value]) => ({
      channelId,
      totalSeconds: value.totalSeconds,
      sessionCount: value.count,
    }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, 5)

  return { summary, recentVoiceSessions, channelBreakdown }
}

export async function getGuildStats(
  guildId: string,
  type: StatsType
): Promise<GuildStatsResult> {
  const supabase = getSupabase()
  const leaderboard = await createActivityLevelService().getRanking(
    guildId,
    type,
    10
  )

  if (supabase === null) {
    return {
      aggregate: emptyAggregate,
      leaderboard,
      distribution: distributionBuckets,
    }
  }

  // Supabase(PostgREST)는 집계 함수(sum 등)를 기본 차단하므로
  // 행을 통째로 가져와 JS에서 집계한다. (분포 계산에도 같은 행을 재사용)
  const levelsTable =
    type === 'text' ? 'guild_text_levels' : 'guild_voice_levels'
  const columns =
    type === 'text'
      ? 'level, xp, message_count'
      : 'level, xp, total_seconds, session_count'

  const rowsResult = await supabase
    .from(levelsTable)
    .select(columns)
    .eq('guild_id', guildId)

  if (rowsResult.error !== null) {
    throw new Error(
      `길드 ${type === 'text' ? '텍스트' : '음성'} 통계 조회 실패: ${
        rowsResult.error.message
      }`
    )
  }

  const rows = ((rowsResult.data ?? []) as unknown[]).filter(record)
  const aggregate: GuildAggregate = {
    participantCount: rows.length,
    totalXp: rows.reduce((sum, r) => sum + num(r.xp), 0),
    totalMetric: rows.reduce(
      (sum, r) =>
        sum + num(type === 'text' ? r.message_count : r.total_seconds),
      0
    ),
    totalSessions:
      type === 'text'
        ? 0
        : rows.reduce((sum, r) => sum + num(r.session_count), 0),
    maxLevel: rows.reduce((max, r) => Math.max(max, num(r.level)), 0),
    avgLevel:
      rows.length === 0
        ? 0
        : rows.reduce((sum, r) => sum + num(r.level), 0) / rows.length,
  }

  if (type === 'text') {
    return {
      aggregate,
      leaderboard,
      distribution: buildDistribution(rows),
    }
  }

  const { data, error } = await supabase
    .from('guild_voice_sessions')
    .select('started_at, duration_seconds')
    .eq('guild_id', guildId)
  if (error !== null)
    throw new Error(`음성 시간대 통계 조회 실패: ${error.message}`)

  return {
    aggregate,
    leaderboard,
    distribution: buildDistribution(rows),
    voiceHourHistogram: buildHourHistogram(data ?? []),
  }
}

function buildDistribution(levels: readonly unknown[]): readonly LevelBucket[] {
  const counts = new Map(distributionBuckets.map((bucket) => [bucket.label, 0]))
  for (const row of levels) {
    const level = record(row) ? num(row.level) : 0
    const bucket = distributionBuckets.find(
      (b) => level >= b.minLevel && level <= b.maxLevel
    )
    if (bucket === undefined) continue
    counts.set(bucket.label, (counts.get(bucket.label) ?? 0) + 1)
  }
  return distributionBuckets.map((bucket) => ({
    ...bucket,
    count: counts.get(bucket.label) ?? 0,
  }))
}

function buildHourHistogram(rows: readonly unknown[]): readonly number[] {
  const bins = new Array<number>(24).fill(0)
  for (const row of rows) {
    if (!record(row) || typeof row.started_at !== 'string') continue
    const hour = (new Date(row.started_at).getUTCHours() + 9 + 24) % 24
    if (hour >= 0 && hour < bins.length) bins[hour] += num(row.duration_seconds)
  }
  return bins
}
