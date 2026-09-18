import {
  drawAvatar,
  drawAvatarHaloRing,
  ellipsize,
  fetchAvatar,
  formatDuration,
  roundRectPath,
} from './activityLevelCardDrawing'
import {
  COLOR_ACCENT,
  COLOR_BORDER,
  COLOR_HEADING,
  COLOR_LABEL,
  COLOR_MEDAL_BRONZE,
  COLOR_MEDAL_GOLD,
  COLOR_MEDAL_SILVER,
  COLOR_SPARKLINE,
  COLOR_SPARKLINE_FILL,
  COLOR_TRACK_TEXT_ACCENT,
  COLOR_TRACK_TEXT_BADGE,
  COLOR_TRACK_VOICE_ACCENT,
  COLOR_TRACK_VOICE_BADGE,
  COLOR_VALUE,
  FONT_FAMILY,
  FONT_FAMILY_BOLD,
  FONT_FAMILY_EXTRABOLD,
  GAUGE_STROKE,
  HISTOGRAM_COLUMN_GAP,
  HISTOGRAM_COLUMN_RADIUS,
  KPI_TILE_RADIUS,
} from './activityStatsCardTheme'
import type { Image, SKRSContext2D } from '@napi-rs/canvas'

export { fetchAvatar, formatDuration }

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

export function drawStatsHeader(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  title: string,
  subtitle: string,
  avatarImage: Image | null,
  trackBadge: 'text' | 'voice'
): void {
  const avatarDiameter = 80
  const avatarCx = x + avatarDiameter / 2
  const avatarCy = y + avatarDiameter / 2

  drawAvatarHaloRing(ctx, avatarCx, avatarCy, avatarDiameter)
  drawAvatar(ctx, avatarImage, avatarCx, avatarCy, avatarDiameter, title)

  const textX = x + avatarDiameter + 20
  const badgeColor =
    trackBadge === 'text' ? COLOR_TRACK_TEXT_ACCENT : COLOR_TRACK_VOICE_ACCENT
  const badgeBg =
    trackBadge === 'text' ? COLOR_TRACK_TEXT_BADGE : COLOR_TRACK_VOICE_BADGE

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = COLOR_HEADING
  ctx.font = `bold 42px ${FONT_FAMILY_EXTRABOLD}`
  ctx.fillText(title, textX, y + 38)

  const badgeText = trackBadge === 'text' ? '채팅' : '음성'
  ctx.font = `bold 18px ${FONT_FAMILY_BOLD}`
  const badgeW = ctx.measureText(badgeText).width + 24
  const badgeH = 30
  const badgeX = textX + ctx.measureText(title).width + 16
  const badgeY = y + 14

  ctx.fillStyle = badgeBg
  roundRectPath(ctx, badgeX, badgeY, badgeW, badgeH, badgeH / 2)
  ctx.fill()

  ctx.fillStyle = badgeColor
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2 + 1)

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = COLOR_LABEL
  ctx.font = `bold 24px ${FONT_FAMILY_BOLD}`
  ctx.fillText(subtitle, textX, y + 74)
}

export function drawKpiTile(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  sub?: string
): void {
  ctx.save()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)'
  roundRectPath(ctx, x, y, w, h, KPI_TILE_RADIUS)
  ctx.fill()

  ctx.strokeStyle = COLOR_BORDER
  ctx.lineWidth = 1
  roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, KPI_TILE_RADIUS)
  ctx.stroke()
  ctx.restore()

  const padX = 22
  const centerY = y + h / 2

  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = COLOR_LABEL
  ctx.font = `bold 18px ${FONT_FAMILY_BOLD}`
  ctx.fillText(label, x + padX, centerY - 12)

  ctx.fillStyle = COLOR_VALUE
  ctx.font = `bold 32px ${FONT_FAMILY_EXTRABOLD}`
  ctx.fillText(value, x + padX, centerY + 18)

  if (sub !== undefined) {
    ctx.fillStyle = COLOR_LABEL
    ctx.font = `500 16px ${FONT_FAMILY}`
    ctx.textAlign = 'right'
    ctx.fillText(sub, x + w - padX, centerY + 18)
  }
}

export function drawRadialGauge(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  radius: number,
  progress: number,
  centerLabel: string,
  subLabel: string
): void {
  const safeProgress = clamp(progress, 0, 1)
  const startAngle = -Math.PI / 2
  const endAngle = startAngle + Math.PI * 2 * safeProgress

  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)'
  ctx.lineWidth = GAUGE_STROKE
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.stroke()

  if (safeProgress > 0) {
    ctx.shadowColor = COLOR_ACCENT
    ctx.shadowBlur = 24
    ctx.strokeStyle = COLOR_ACCENT
    ctx.lineWidth = GAUGE_STROKE
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(cx, cy, radius, startAngle, endAngle)
    ctx.stroke()
  }
  ctx.restore()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = COLOR_VALUE
  ctx.font = `bold 36px ${FONT_FAMILY_EXTRABOLD}`
  ctx.fillText(centerLabel, cx, cy - 6)

  ctx.fillStyle = COLOR_LABEL
  ctx.font = `bold 16px ${FONT_FAMILY_BOLD}`
  ctx.fillText(subLabel, cx, cy + 24)
}

export function drawLeaderboardRow(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  rank: number,
  name: string,
  level: number,
  xp: number,
  metric: string
): void {
  const rowH = 50
  const medalColors = [COLOR_MEDAL_GOLD, COLOR_MEDAL_SILVER, COLOR_MEDAL_BRONZE]
  const rankSize = 32
  const rankCx = x + rankSize / 2
  const rankCy = y + rowH / 2

  ctx.save()
  if (rank <= 3) {
    ctx.fillStyle = medalColors[rank - 1]
    ctx.beginPath()
    ctx.arc(rankCx, rankCy, rankSize / 2, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = '#10183a'
    ctx.font = `bold 14px ${FONT_FAMILY_BOLD}`
  } else {
    ctx.fillStyle = COLOR_LABEL
    ctx.font = `bold 14px ${FONT_FAMILY_BOLD}`
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(rank), rankCx, rankCy + 1)
  ctx.restore()

  const nameX = x + 48
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = COLOR_VALUE
  ctx.font = `bold 22px ${FONT_FAMILY_BOLD}`

  const xpText = `${xp.toLocaleString()} XP`
  ctx.font = `500 18px ${FONT_FAMILY}`
  const xpW = ctx.measureText(xpText).width

  const metricFont = `500 16px ${FONT_FAMILY}`
  ctx.font = metricFont
  const metricW = ctx.measureText(metric).width

  const levelText = `Lv.${level}`
  ctx.font = `bold 14px ${FONT_FAMILY_BOLD}`
  const levelW = ctx.measureText(levelText).width + 18
  const pillH = 26

  const rightEdge = x + w - 12
  const xpX = rightEdge
  const metricRight = xpX - xpW - 16
  const metricLeft = metricRight - metricW
  const pillRight = metricLeft - 16
  const pillX = Math.max(nameX + 16, pillRight - levelW)
  const pillY = y + (rowH - pillH) / 2

  const nameW = pillX - 16 - nameX
  ctx.fillStyle = COLOR_VALUE
  ctx.font = `bold 22px ${FONT_FAMILY_BOLD}`
  ctx.fillText(ellipsize(ctx, name, nameW), nameX, y + rowH / 2)

  ctx.fillStyle = 'rgba(122, 162, 255, 0.28)'
  roundRectPath(ctx, pillX, pillY, levelW, pillH, pillH / 2)
  ctx.fill()

  ctx.fillStyle = '#eaf1ff'
  ctx.font = `bold 14px ${FONT_FAMILY_BOLD}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(levelText, pillX + levelW / 2, y + rowH / 2 + 1)

  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = COLOR_VALUE
  ctx.font = `500 18px ${FONT_FAMILY}`
  ctx.fillText(xpText, xpX, y + rowH / 2)

  ctx.fillStyle = COLOR_LABEL
  ctx.font = metricFont
  ctx.fillText(metric, metricRight, y + rowH / 2)
}

export function drawHistogram(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  buckets: ReadonlyArray<readonly [string, number, number]>
): void {
  const n = buckets.length
  if (n === 0) return

  const gap = HISTOGRAM_COLUMN_GAP
  const colW = (w - gap * (n - 1)) / n
  const maxCount = Math.max(1, ...buckets.map(([, , max]) => max))

  ctx.strokeStyle = COLOR_BORDER
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, y + h)
  ctx.lineTo(x + w, y + h)
  ctx.stroke()

  for (let i = 0; i < n; i += 1) {
    const [label, count] = buckets[i]
    const colH = (count / maxCount) * h
    const colX = x + i * (colW + gap)
    const colY = y + h - colH

    if (count > 0) {
      const grad = ctx.createLinearGradient(colX, y + h, colX, colY)
      grad.addColorStop(0, COLOR_ACCENT)
      grad.addColorStop(1, '#c4d8ff')
      ctx.fillStyle = grad
      roundRectPath(ctx, colX, colY, colW, colH, HISTOGRAM_COLUMN_RADIUS)
      ctx.fill()

      ctx.fillStyle = COLOR_VALUE
      ctx.font = `bold 13px ${FONT_FAMILY_BOLD}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText(String(count), colX + colW / 2, colY - 4)
    }

    const shouldDrawLabel = n <= 8 || i % 3 === 0
    ctx.fillStyle = COLOR_LABEL
    ctx.font = `500 14px ${FONT_FAMILY}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    if (shouldDrawLabel) {
      ctx.fillText(label, colX + colW / 2, y + h + 8)
    }
  }
}

export function drawSparkline(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  points: readonly number[]
): void {
  if (points.length < 2) {
    ctx.strokeStyle = COLOR_BORDER
    ctx.lineWidth = 1
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    ctx.moveTo(x, y + h / 2)
    ctx.lineTo(x + w, y + h / 2)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.fillStyle = COLOR_LABEL
    ctx.font = `500 16px ${FONT_FAMILY}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('기록 없음', x + w / 2, y + h / 2)
    return
  }

  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const stepX = w / (points.length - 1)

  const coords = points.map((point, index) => ({
    x: x + index * stepX,
    y: y + h - ((point - min) / range) * h,
  }))

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(coords[0].x, coords[0].y)
  for (let i = 1; i < coords.length; i += 1) {
    ctx.lineTo(coords[i].x, coords[i].y)
  }
  ctx.lineTo(coords[coords.length - 1].x, y + h)
  ctx.lineTo(coords[0].x, y + h)
  ctx.closePath()
  ctx.fillStyle = COLOR_SPARKLINE_FILL
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.strokeStyle = COLOR_SPARKLINE
  ctx.lineWidth = 3
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(coords[0].x, coords[0].y)
  for (let i = 1; i < coords.length; i += 1) {
    ctx.lineTo(coords[i].x, coords[i].y)
  }
  ctx.stroke()
  ctx.restore()
}

export function drawMiniBar(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  progress: number
): void {
  const safeProgress = clamp(progress, 0, 1)
  const radius = h / 2

  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)'
  roundRectPath(ctx, x, y, w, h, radius)
  ctx.fill()

  if (safeProgress > 0) {
    const fillW = Math.max(h, w * safeProgress)
    ctx.save()
    roundRectPath(ctx, x, y, w, h, radius)
    ctx.clip()
    const grad = ctx.createLinearGradient(x, 0, x + w, 0)
    grad.addColorStop(0, COLOR_ACCENT)
    grad.addColorStop(1, '#c4d8ff')
    ctx.fillStyle = grad
    ctx.fillRect(x, y, fillW, h)
    ctx.restore()
  }
}

export function drawWatermark(
  ctx: SKRSContext2D,
  cardWidth: number,
  cardHeight: number
): void {
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)'
  ctx.font = `500 16px ${FONT_FAMILY}`
  ctx.fillText('Lisy', cardWidth - 28, cardHeight - 22)
}

export function drawOuterBorder(
  ctx: SKRSContext2D,
  w: number,
  h: number,
  radius: number
): void {
  ctx.strokeStyle = COLOR_BORDER
  ctx.lineWidth = 1
  roundRectPath(ctx, 0.5, 0.5, w - 1, h - 1, radius)
  ctx.stroke()
}
