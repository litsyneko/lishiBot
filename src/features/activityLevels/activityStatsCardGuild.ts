import { drawNightBackground } from './activityLevelCardBackground'
import { roundRectPath } from './activityLevelCardDrawing'
import type { GuildStatsResult, StatsType } from './activityLevelStats'
import {
  COLOR_HEADING,
  FONT_FAMILY_BOLD,
  KPI_TILE_GAP,
  KPI_TILE_HEIGHT,
  STATS_CARD_HEIGHT_GUILD,
  STATS_CARD_RADIUS,
  STATS_CARD_WIDTH,
  ensureActivityLevelCardFontsRegistered,
} from './activityStatsCardTheme'
import {
  drawHistogram,
  drawKpiTile,
  drawLeaderboardRow,
  drawOuterBorder,
  drawStatsHeader,
  drawWatermark,
  fetchAvatar,
  formatDuration,
} from './activityStatsCardWidgets'
import { type SKRSContext2D, createCanvas } from '@napi-rs/canvas'

export type GuildStatsCardInput = {
  readonly guildName: string
  readonly guildIconUrl: string | null
  readonly type: StatsType
  readonly result: GuildStatsResult
  readonly displayNames?: ReadonlyMap<string, string>
}

export async function renderGuildStatsCard(
  input: GuildStatsCardInput
): Promise<Buffer> {
  ensureActivityLevelCardFontsRegistered()

  const canvas = createCanvas(STATS_CARD_WIDTH, STATS_CARD_HEIGHT_GUILD)
  const ctx = canvas.getContext('2d')

  roundRectPath(
    ctx,
    0,
    0,
    STATS_CARD_WIDTH,
    STATS_CARD_HEIGHT_GUILD,
    STATS_CARD_RADIUS
  )
  ctx.save()
  ctx.clip()
  drawNightBackground(ctx, STATS_CARD_WIDTH, STATS_CARD_HEIGHT_GUILD)
  ctx.restore()

  const { aggregate, leaderboard, distribution, voiceHourHistogram } =
    input.result

  if (aggregate.participantCount === 0) {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = COLOR_HEADING
    ctx.font = `bold 42px ${FONT_FAMILY_BOLD}`
    ctx.fillText(
      '아직 통계 기록이 없어요.',
      STATS_CARD_WIDTH / 2,
      STATS_CARD_HEIGHT_GUILD / 2
    )
    drawWatermark(ctx, STATS_CARD_WIDTH, STATS_CARD_HEIGHT_GUILD)
    drawOuterBorder(
      ctx,
      STATS_CARD_WIDTH,
      STATS_CARD_HEIGHT_GUILD,
      STATS_CARD_RADIUS
    )
    return canvas.encode('png')
  }

  const iconImage = await fetchAvatar(input.guildIconUrl ?? '')
  const headerW = STATS_CARD_WIDTH - 120

  drawStatsHeader(
    ctx,
    60,
    40,
    headerW,
    `${input.guildName} 전체 지표`,
    input.type === 'text' ? '채팅 활동' : '음성 활동',
    iconImage,
    input.type
  )

  drawKpiStrip(ctx, 160, aggregate, input.type)

  const rowY = 300
  const rowW = STATS_CARD_WIDTH - 120
  leaderboard.forEach((entry, index) => {
    const rank = index + 1
    const name = input.displayNames?.get(entry.userId) ?? `유저 ${rank}`
    const metric =
      input.type === 'text'
        ? `${entry.metric.toLocaleString()}메시지`
        : formatDuration(entry.metric)
    drawLeaderboardRow(
      ctx,
      60,
      rowY + index * 50,
      rowW,
      rank,
      name,
      entry.level,
      entry.xp,
      metric
    )
  })

  const maxCount = Math.max(...distribution.map((b) => b.count), 1)
  const buckets: ReadonlyArray<readonly [string, number, number]> =
    distribution.map((b) => [b.label, b.count, maxCount] as const)
  drawHistogram(ctx, 60, 850, STATS_CARD_WIDTH - 120, 120, buckets)

  if (voiceHourHistogram !== undefined && input.type === 'voice') {
    const hourMax = Math.max(...voiceHourHistogram, 1)
    const hourBuckets: ReadonlyArray<readonly [string, number, number]> =
      voiceHourHistogram.map((count, hour) => {
        const label = `${hour}시`
        return [label, count, hourMax] as const
      })
    drawHistogram(ctx, 60, 990, STATS_CARD_WIDTH - 120, 80, hourBuckets)
  }

  drawWatermark(ctx, STATS_CARD_WIDTH, STATS_CARD_HEIGHT_GUILD)
  drawOuterBorder(
    ctx,
    STATS_CARD_WIDTH,
    STATS_CARD_HEIGHT_GUILD,
    STATS_CARD_RADIUS
  )

  return canvas.encode('png')
}

function drawKpiStrip(
  ctx: SKRSContext2D,
  y: number,
  aggregate: GuildStatsResult['aggregate'],
  type: StatsType
): void {
  const labels: string[] = ['참여 유저', '총 XP']
  const values: string[] = [
    aggregate.participantCount.toLocaleString(),
    aggregate.totalXp.toLocaleString(),
  ]

  if (type === 'text') {
    labels.push('총 메시지')
    values.push(aggregate.totalMetric.toLocaleString())
  } else {
    labels.push('총 음성시간')
    values.push(formatDuration(aggregate.totalMetric))
  }

  labels.push('최고 레벨')
  values.push(`Lv.${aggregate.maxLevel}`)

  if (type === 'voice') {
    labels.push('총 세션')
    values.push(aggregate.totalSessions.toLocaleString())
  }

  const n = labels.length
  const totalGap = KPI_TILE_GAP * (n - 1)
  const tileW = (STATS_CARD_WIDTH - 120 - totalGap) / n

  for (let i = 0; i < n; i += 1) {
    drawKpiTile(
      ctx,
      60 + i * (tileW + KPI_TILE_GAP),
      y,
      tileW,
      KPI_TILE_HEIGHT,
      labels[i],
      values[i]
    )
  }
}
