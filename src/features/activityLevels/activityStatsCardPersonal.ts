import { drawNightBackground } from './activityLevelCardBackground'
import { roundRectPath } from './activityLevelCardDrawing'
import { type PersonalStatsResult, type StatsType } from './activityLevelStats'
import {
  COLOR_LABEL,
  COLOR_VALUE,
  FONT_FAMILY,
  FONT_FAMILY_BOLD,
  FONT_FAMILY_EXTRABOLD,
  GAUGE_RADIUS,
  KPI_TILE_GAP,
  KPI_TILE_HEIGHT,
  STATS_CARD_HEIGHT_PERSONAL,
  STATS_CARD_RADIUS,
  STATS_CARD_WIDTH,
  ensureActivityLevelCardFontsRegistered,
} from './activityStatsCardTheme'
import {
  drawKpiTile,
  drawMiniBar,
  drawOuterBorder,
  drawRadialGauge,
  drawSparkline,
  drawStatsHeader,
  drawWatermark,
  fetchAvatar,
  formatDuration,
} from './activityStatsCardWidgets'
import { type SKRSContext2D, createCanvas } from '@napi-rs/canvas'

export type PersonalStatsCardInput = {
  readonly username: string
  readonly avatarUrl: string
  readonly type: StatsType
  readonly result: PersonalStatsResult
}

const PADDING_X = 60
const HEADER_Y = 40
const KPI_Y = 160
const GAUGE_CX = 300
const GAUGE_CY = 460
const RIGHT_X = 500
const RIGHT_W = STATS_CARD_WIDTH - 560
const NO_DATA_LABEL = '기록 없음'

function drawKpiStrip(
  ctx: SKRSContext2D,
  input: PersonalStatsCardInput,
  hasData: boolean
): void {
  const { summary } = input.result
  const type = input.type
  const tileW = (STATS_CARD_WIDTH - PADDING_X * 2 - KPI_TILE_GAP * 3) / 4

  const tiles: readonly {
    readonly label: string
    readonly value: string
    readonly sub?: string
  }[] = [
    { label: '레벨', value: hasData ? `Lv.${summary.level}` : NO_DATA_LABEL },
    {
      label: '총 XP',
      value: hasData ? summary.xp.toLocaleString() : NO_DATA_LABEL,
    },
    {
      label: type === 'text' ? '메시지' : '음성 시간',
      value: hasData
        ? type === 'text'
          ? `${summary.metric.toLocaleString()}개`
          : formatDuration(summary.metric)
        : NO_DATA_LABEL,
    },
    {
      label: '길드 순위',
      value: hasData
        ? `#${summary.rank} / ${summary.totalParticipants}`
        : NO_DATA_LABEL,
      sub: hasData ? `상위 ${summary.percentile}%` : undefined,
    },
  ]

  for (let i = 0; i < tiles.length; i += 1) {
    const x = PADDING_X + i * (tileW + KPI_TILE_GAP)
    const tile = tiles[i]
    drawKpiTile(
      ctx,
      x,
      KPI_Y,
      tileW,
      KPI_TILE_HEIGHT,
      tile.label,
      tile.value,
      tile.sub
    )
  }
}

function drawTextRightBlock(ctx: SKRSContext2D, percentile: number): void {
  const labelY = 340
  const barY = labelY + 28
  const barH = 24

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = COLOR_LABEL
  ctx.font = `bold 20px ${FONT_FAMILY_BOLD}`
  ctx.fillText('다음 레벨까지', RIGHT_X, labelY)

  drawMiniBar(ctx, RIGHT_X, barY, RIGHT_W, barH, percentile / 100)

  ctx.fillStyle = COLOR_VALUE
  ctx.font = `bold 18px ${FONT_FAMILY_EXTRABOLD}`
  ctx.fillText(
    `현재 상위 ${percentile}%의 유저보다 높습니다`,
    RIGHT_X,
    barY + barH + 36
  )
}

function drawVoiceRightBlock(
  ctx: SKRSContext2D,
  result: PersonalStatsResult,
  hasData: boolean
): void {
  const { recentVoiceSessions, channelBreakdown } = result
  const sparklineY = 330
  const sparklineH = 140
  const points = hasData
    ? (recentVoiceSessions ?? []).map((session) => session.durationSeconds)
    : []

  drawSparkline(ctx, RIGHT_X, sparklineY, RIGHT_W, sparklineH, points)

  if (
    !hasData ||
    channelBreakdown === undefined ||
    channelBreakdown.length === 0
  ) {
    return
  }

  const listY = sparklineY + sparklineH + 40
  const rowH = 36
  const maxRows = 5
  const rows = channelBreakdown.slice(0, maxRows)

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = COLOR_LABEL
  ctx.font = `bold 18px ${FONT_FAMILY_BOLD}`
  ctx.fillText('채널별 음성 활동', RIGHT_X, listY - 12)

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const y = listY + i * rowH
    const channelText = `#${row.channelId}`

    ctx.fillStyle = COLOR_VALUE
    ctx.font = `500 18px ${FONT_FAMILY}`
    ctx.fillText(channelText, RIGHT_X, y)

    const timeText = formatDuration(row.totalSeconds)
    const countText = `${row.sessionCount}회`

    ctx.textAlign = 'right'
    ctx.fillStyle = COLOR_VALUE
    ctx.font = `bold 18px ${FONT_FAMILY_BOLD}`
    ctx.fillText(timeText, RIGHT_X + RIGHT_W, y)

    const countW = ctx.measureText(countText).width
    ctx.fillStyle = COLOR_LABEL
    ctx.font = `500 16px ${FONT_FAMILY}`
    ctx.fillText(countText, RIGHT_X + RIGHT_W - countW - 16, y)
    ctx.textAlign = 'left'
  }
}

export async function renderPersonalStatsCard(
  input: PersonalStatsCardInput
): Promise<Buffer> {
  ensureActivityLevelCardFontsRegistered()

  const canvas = createCanvas(STATS_CARD_WIDTH, STATS_CARD_HEIGHT_PERSONAL)
  const ctx = canvas.getContext('2d')

  roundRectPath(
    ctx,
    0,
    0,
    STATS_CARD_WIDTH,
    STATS_CARD_HEIGHT_PERSONAL,
    STATS_CARD_RADIUS
  )
  ctx.save()
  ctx.clip()
  drawNightBackground(ctx, STATS_CARD_WIDTH, STATS_CARD_HEIGHT_PERSONAL)
  ctx.restore()

  const avatarImage = await fetchAvatar(input.avatarUrl)
  const subtitle = input.type === 'text' ? '채팅 활동' : '음성 활동'
  drawStatsHeader(
    ctx,
    PADDING_X,
    HEADER_Y,
    STATS_CARD_WIDTH - PADDING_X * 2,
    `${input.username}님의 활동 통계`,
    subtitle,
    avatarImage,
    input.type
  )

  const { summary } = input.result
  const type = input.type
  const hasData =
    summary.totalParticipants > 0 && !(summary.level === 1 && summary.xp === 0)

  drawKpiStrip(ctx, input, hasData)

  const progress = summary.xpNeeded <= 0 ? 0 : summary.xp / summary.xpNeeded
  drawRadialGauge(
    ctx,
    GAUGE_CX,
    GAUGE_CY,
    GAUGE_RADIUS,
    progress,
    `Lv.${summary.level}`,
    hasData ? `${summary.xpRemaining.toLocaleString()} XP 남음` : NO_DATA_LABEL
  )

  if (type === 'text') {
    drawTextRightBlock(ctx, summary.percentile)
  } else {
    drawVoiceRightBlock(ctx, input.result, hasData)
  }

  drawWatermark(ctx, STATS_CARD_WIDTH, STATS_CARD_HEIGHT_PERSONAL)
  drawOuterBorder(
    ctx,
    STATS_CARD_WIDTH,
    STATS_CARD_HEIGHT_PERSONAL,
    STATS_CARD_RADIUS
  )

  return canvas.encode('png')
}
