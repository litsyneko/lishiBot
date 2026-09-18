import {
  COLOR_ACCENT,
  COLOR_AVATAR_RING,
  COLOR_LABEL,
  COLOR_NIGHT_GLOW,
  COLOR_VALUE,
  FONT_FAMILY,
  FONT_FAMILY_BOLD,
  FONT_FAMILY_EXTRABOLD,
} from './activityLevelCardTheme'
import { Image, type SKRSContext2D, loadImage } from '@napi-rs/canvas'

export function roundRectPath(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

export async function fetchAvatar(avatarUrl: string): Promise<Image | null> {
  try {
    const res = await fetch(avatarUrl, { method: 'GET' })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return null
    return await loadImage(buf)
  } catch {
    return null
  }
}

function drawPlaceholderAvatar(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  radius: number,
  username: string
): void {
  const gradient = ctx.createLinearGradient(
    cx - radius,
    cy - radius,
    cx + radius,
    cy + radius
  )
  gradient.addColorStop(0, COLOR_AVATAR_RING)
  gradient.addColorStop(1, COLOR_NIGHT_GLOW)
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fill()

  const firstChar = username.trim().charAt(0).toUpperCase() || '?'
  ctx.fillStyle = COLOR_VALUE
  ctx.font = `bold ${Math.floor(radius * 1.1)}px ${FONT_FAMILY_EXTRABOLD}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(firstChar, cx, cy + radius * 0.05)
}

export function drawAvatar(
  ctx: SKRSContext2D,
  image: Image | null,
  cx: number,
  cy: number,
  diameter: number,
  username: string
): void {
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, diameter / 2, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()

  if (image !== null) {
    const size = Math.max(image.width, image.height)
    const scale = diameter / size
    const drawW = image.width * scale
    const drawH = image.height * scale
    ctx.drawImage(image, cx - drawW / 2, cy - drawH / 2, drawW, drawH)
  } else {
    drawPlaceholderAvatar(ctx, cx, cy, diameter / 2, username)
  }
  ctx.restore()
}

export function drawAvatarHaloRing(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  diameter: number
): void {
  ctx.save()
  ctx.shadowColor = COLOR_AVATAR_RING
  ctx.shadowBlur = 40
  ctx.strokeStyle = COLOR_AVATAR_RING
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.arc(cx, cy, diameter / 2 + 10, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

export function drawTrackRow(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  label: string,
  level: number,
  xp: number,
  xpNeeded: number,
  metric: string
): void {
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  // Label
  ctx.fillStyle = COLOR_LABEL
  ctx.font = `bold 40px ${FONT_FAMILY_EXTRABOLD}`
  ctx.fillText(label, x, y)

  // Level pill
  const levelText = `Lv.${level}`
  ctx.font = `bold 26px ${FONT_FAMILY_EXTRABOLD}`
  const levelW = ctx.measureText(levelText).width
  const pillPadX = 20
  const pillH = 42
  const pillX = x + w - levelW - pillPadX * 2
  const pillY = y - pillH + 8
  ctx.fillStyle = 'rgba(122, 162, 255, 0.16)'
  roundRectPath(ctx, pillX, pillY, levelW + pillPadX * 2, pillH, pillH / 2)
  ctx.fill()
  ctx.fillStyle = COLOR_ACCENT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(levelText, pillX + pillPadX + levelW / 2, pillY + pillH / 2 + 2)

  // Metric line
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = COLOR_LABEL
  ctx.font = `500 22px ${FONT_FAMILY}`
  ctx.fillText(metric, x, y + 44)

  // XP progress bar
  const barY = y + 62
  const barH = 28
  const barRadius = barH / 2
  const progress = xpNeeded <= 0 ? 0 : Math.min(Math.max(xp / xpNeeded, 0), 1)

  // Track (dark, high-contrast)
  ctx.fillStyle = 'rgba(8, 12, 30, 0.85)'
  roundRectPath(ctx, x, barY, w, barH, barRadius)
  ctx.fill()

  // Inner rim
  ctx.strokeStyle = 'rgba(122, 162, 255, 0.25)'
  ctx.lineWidth = 1
  roundRectPath(ctx, x + 0.5, barY + 0.5, w - 1, barH - 1, barRadius)
  ctx.stroke()

  // Filled portion with glow
  if (progress > 0) {
    const fillW = Math.max(barH, w * progress)
    ctx.save()
    roundRectPath(ctx, x, barY, w, barH, barRadius)
    ctx.clip()
    ctx.shadowColor = COLOR_ACCENT
    ctx.shadowBlur = 8
    const fill = ctx.createLinearGradient(x, 0, x + w, 0)
    fill.addColorStop(0, COLOR_ACCENT)
    fill.addColorStop(1, '#c4d8ff')
    ctx.fillStyle = fill
    ctx.fillRect(x, barY, fillW, barH)
    ctx.restore()
  }

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = COLOR_VALUE
  ctx.font = `bold 16px ${FONT_FAMILY_BOLD}`
  ctx.fillText(
    `${xp.toLocaleString()} / ${xpNeeded.toLocaleString()} XP`,
    x + w / 2,
    barY + barH / 2 + 1
  )
}

export function ellipsize(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number
): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  const ellipsis = '…'
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    const candidate = text.slice(0, mid) + ellipsis
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return lo === 0 ? ellipsis : text.slice(0, lo) + ellipsis
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}시간 ${minutes}분`
  return `${minutes}분`
}
