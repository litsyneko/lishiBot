import { formatWon } from '../../config/korea'
import {
  GlobalFonts,
  Image,
  type SKRSContext2D,
  createCanvas,
  loadImage,
} from '@napi-rs/canvas'
import path from 'node:path'

export type LevelCardInput = {
  readonly level: number
  readonly xp: number
  readonly xpNeeded: number
  readonly balance: number
  readonly bankBalance: number
  readonly username: string
  readonly avatarUrl: string
}

const CARD_WIDTH = 960
const CARD_HEIGHT = 320
const CARD_RADIUS = 24

// Brand palette
const COLOR_BG_TOP = '#0F0F23'
const COLOR_BG_BOTTOM = '#1a1a2e'
const COLOR_ACCENT_START = '#5865F2'
const COLOR_ACCENT_END = '#EB459E'
const COLOR_TEXT_PRIMARY = '#FFFFFF'
const COLOR_TEXT_MUTED = '#B0B5BF'
const COLOR_POSITIVE = '#3DD68C'
const COLOR_TRACK = '#2A2A3E'
const COLOR_BORDER = 'rgba(255, 255, 255, 0.06)'

const FONT_FAMILY = 'Pretendard'
const FONT_FAMILY_BOLD = 'Pretendard Bold'
const FONT_FAMILY_EXTRABOLD = 'Pretendard ExtraBold'

let fontsRegistered = false

function ensureFontsRegistered(): void {
  if (fontsRegistered) return
  const fontsDir = path.resolve(__dirname, '..', '..', '..', 'assets', 'fonts')
  GlobalFonts.registerFromPath(
    path.join(fontsDir, 'Pretendard-Regular.woff2'),
    FONT_FAMILY
  )
  GlobalFonts.registerFromPath(
    path.join(fontsDir, 'Pretendard-Bold.woff2'),
    FONT_FAMILY_BOLD
  )
  GlobalFonts.registerFromPath(
    path.join(fontsDir, 'Pretendard-ExtraBold.woff2'),
    FONT_FAMILY_EXTRABOLD
  )
  fontsRegistered = true
}

function roundRectPath(
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

async function fetchAvatar(avatarUrl: string): Promise<Image | null> {
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
  gradient.addColorStop(0, COLOR_ACCENT_START)
  gradient.addColorStop(1, COLOR_ACCENT_END)
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fill()

  const firstChar = username.trim().charAt(0).toUpperCase() || '?'
  ctx.fillStyle = COLOR_TEXT_PRIMARY
  ctx.font = `bold ${Math.floor(radius * 1.1)}px ${FONT_FAMILY_EXTRABOLD}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(firstChar, cx, cy + radius * 0.05)
}

function drawAvatar(
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

function drawLevelBadge(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  radius: number,
  level: number
): void {
  // Outer glowing ring
  ctx.save()
  ctx.shadowColor = COLOR_ACCENT_END
  ctx.shadowBlur = 16
  const ring = ctx.createLinearGradient(
    cx - radius,
    cy - radius,
    cx + radius,
    cy + radius
  )
  ring.addColorStop(0, COLOR_ACCENT_START)
  ring.addColorStop(1, COLOR_ACCENT_END)
  ctx.fillStyle = ring
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.fillStyle = COLOR_BG_TOP
  ctx.beginPath()
  ctx.arc(cx, cy, radius - 4, 0, Math.PI * 2)
  ctx.fill()

  // Text
  ctx.fillStyle = COLOR_TEXT_PRIMARY
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold 20px ${FONT_FAMILY_BOLD}`
  ctx.fillText('Lv.', cx, cy - radius * 0.34)
  ctx.font = `bold ${Math.floor(radius * 0.58)}px ${FONT_FAMILY_EXTRABOLD}`
  ctx.fillText(String(level), cx, cy + radius * 0.16)
}

function drawStatCell(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  valueColor: string
): void {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)'
  roundRectPath(ctx, x, y, w, h, 12)
  ctx.fill()
  ctx.strokeStyle = COLOR_BORDER
  ctx.lineWidth = 1
  roundRectPath(ctx, x, y, w, h, 12)
  ctx.stroke()

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = COLOR_TEXT_MUTED
  ctx.font = `600 15px ${FONT_FAMILY_BOLD}`
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 1
  ctx.fillText(label, x + 18, y + 30)
  ctx.shadowColor = 'transparent'

  ctx.fillStyle = valueColor
  ctx.font = `bold 26px ${FONT_FAMILY_BOLD}`
  ctx.fillText(value, x + 18, y + h - 18)
}

function drawSparkle(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
  alpha: number
): void {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.beginPath()
  // four-pointed star
  const arms = 4
  for (let i = 0; i < arms * 2; i++) {
    const angle = (i / (arms * 2)) * Math.PI * 2 - Math.PI / 2
    const r = i % 2 === 0 ? size : size * 0.32
    const px = cx + Math.cos(angle) * r
    const py = cy + Math.sin(angle) * r
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

export async function renderLevelCard(input: LevelCardInput): Promise<Buffer> {
  ensureFontsRegistered()

  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT)
  const ctx = canvas.getContext('2d')

  // ---- Card clip + background ----
  roundRectPath(ctx, 0, 0, CARD_WIDTH, CARD_HEIGHT, CARD_RADIUS)
  ctx.save()
  ctx.clip()

  const bg = ctx.createLinearGradient(0, 0, 0, CARD_HEIGHT)
  bg.addColorStop(0, COLOR_BG_TOP)
  bg.addColorStop(1, COLOR_BG_BOTTOM)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)

  // Subtle radial glow behind avatar
  const glow = ctx.createRadialGradient(
    160,
    CARD_HEIGHT / 2,
    10,
    160,
    CARD_HEIGHT / 2,
    320
  )
  glow.addColorStop(0, 'rgba(88, 101, 242, 0.28)')
  glow.addColorStop(1, 'rgba(88, 101, 242, 0.0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)

  // Secondary pinkish glow, lower-right
  const glow2 = ctx.createRadialGradient(
    CARD_WIDTH - 120,
    CARD_HEIGHT - 40,
    8,
    CARD_WIDTH - 120,
    CARD_HEIGHT - 40,
    280
  )
  glow2.addColorStop(0, 'rgba(235, 69, 158, 0.18)')
  glow2.addColorStop(1, 'rgba(235, 69, 158, 0.0)')
  ctx.fillStyle = glow2
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)

  // Top accent line (brand gradient)
  const accentLine = ctx.createLinearGradient(0, 0, CARD_WIDTH, 0)
  accentLine.addColorStop(0, COLOR_ACCENT_START)
  accentLine.addColorStop(1, COLOR_ACCENT_END)
  ctx.fillStyle = accentLine
  ctx.fillRect(0, 0, CARD_WIDTH, 3)

  // Decorative sparkles
  drawSparkle(ctx, CARD_WIDTH - 60, 50, 7, '#FFFFFF', 0.55)
  drawSparkle(ctx, CARD_WIDTH - 110, 80, 4, COLOR_ACCENT_END, 0.4)
  drawSparkle(ctx, 320, 56, 5, COLOR_ACCENT_START, 0.35)

  ctx.restore()

  // ---- Avatar (left section) ----
  const avatarCx = 160
  const avatarCy = CARD_HEIGHT / 2 + 4
  const avatarDiameter = 220
  const image = await fetchAvatar(input.avatarUrl)
  drawAvatar(ctx, image, avatarCx, avatarCy, avatarDiameter, input.username)

  // Avatar outer ring (subtle border for separation)
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(avatarCx, avatarCy, avatarDiameter / 2 + 1, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  // Level badge — sits at bottom-right of avatar
  const badgeCx = avatarCx + avatarDiameter / 2 - 18
  const badgeCy = avatarCy + avatarDiameter / 2 - 18
  const badgeRadius = 44
  drawLevelBadge(ctx, badgeCx, badgeCy, badgeRadius, input.level)

  // ---- Right section ----
  const rightX = 320
  const rightW = CARD_WIDTH - rightX - 40

  // Username
  ctx.fillStyle = COLOR_TEXT_PRIMARY
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `bold 36px ${FONT_FAMILY_BOLD}`
  const maxNameW = rightW - 100
  const nameText = ellipsize(ctx, input.username, maxNameW)
  ctx.fillText(nameText, rightX, 86)

  // Total assets label (prominent header metric)
  const total = input.balance + input.bankBalance
  ctx.fillStyle = COLOR_TEXT_PRIMARY
  ctx.font = `bold 18px ${FONT_FAMILY_BOLD}`
  ctx.fillText(`총 자산 ${formatWon(total)}`, rightX, 114)

  // Stats grid: two cells
  const cellGap = 24
  const cellW = (rightW - cellGap) / 2
  const cellH = 78
  const cellY = 132
  drawStatCell(
    ctx,
    rightX,
    cellY,
    cellW,
    cellH,
    '잔액',
    formatWon(input.balance),
    COLOR_POSITIVE
  )
  drawStatCell(
    ctx,
    rightX + cellW + cellGap,
    cellY,
    cellW,
    cellH,
    '예금',
    formatWon(input.bankBalance),
    COLOR_TEXT_PRIMARY
  )

  // ---- XP progress bar ----
  const barX = rightX
  const barW = rightW
  const barY = 244
  const barH = 34
  const barRadius = barH / 2

  const progressClamped =
    input.xpNeeded <= 0 ? 0 : Math.min(1, input.xp / input.xpNeeded)
  const progressPct = Math.round(progressClamped * 100)

  // Track
  ctx.fillStyle = COLOR_TRACK
  roundRectPath(ctx, barX, barY, barW, barH, barRadius)
  ctx.fill()

  // Fill
  if (progressClamped > 0) {
    const fillW = Math.max(barH, barW * progressClamped)
    ctx.save()
    roundRectPath(ctx, barX, barY, barW, barH, barRadius)
    ctx.clip()
    const fill = ctx.createLinearGradient(barX, 0, barX + barW, 0)
    fill.addColorStop(0, COLOR_ACCENT_START)
    fill.addColorStop(1, COLOR_ACCENT_END)
    ctx.fillStyle = fill
    ctx.fillRect(barX, barY, fillW, barH)
    ctx.restore()
  }

  // XP text overlaid on a dark pill for contrast
  const xpText = `${input.xp.toLocaleString()} / ${input.xpNeeded.toLocaleString()} XP`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold 15px ${FONT_FAMILY_BOLD}`
  const xpMetrics = ctx.measureText(xpText)
  const xpTextX = barX + barW / 2
  const xpTextY = barY + barH / 2 + 1
  const xpPillPaddingX = 10
  const xpPillPaddingY = 6
  const xpPillW = xpMetrics.width + xpPillPaddingX * 2
  const xpPillH = 22 + xpPillPaddingY * 2
  ctx.fillStyle = 'rgba(15, 15, 35, 0.72)'
  roundRectPath(
    ctx,
    xpTextX - xpPillW / 2,
    xpTextY - xpPillH / 2,
    xpPillW,
    xpPillH,
    xpPillH / 2
  )
  ctx.fill()

  ctx.fillStyle = COLOR_TEXT_PRIMARY
  ctx.fillText(xpText, xpTextX, xpTextY)

  // Percentage label under bar, right-aligned; level-up hint left-aligned
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = COLOR_TEXT_MUTED
  ctx.font = `600 13px ${FONT_FAMILY_BOLD}`
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 1
  ctx.fillText('다음 레벨까지', barX, barY + barH + 20)
  ctx.shadowColor = 'transparent'

  ctx.textAlign = 'right'
  ctx.fillStyle = COLOR_TEXT_PRIMARY
  ctx.font = `bold 16px ${FONT_FAMILY_BOLD}`
  ctx.fillText(`${progressPct}%`, barX + barW, barY + barH + 20)

  // ---- Watermark (subtle icon-like mark) ----
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)'
  ctx.font = `500 10px ${FONT_FAMILY}`
  ctx.fillText('Lisy', CARD_WIDTH - 18, CARD_HEIGHT - 14)

  // ---- Card outer border + drop shadow ring ----
  ctx.strokeStyle = COLOR_BORDER
  ctx.lineWidth = 1
  roundRectPath(ctx, 0.5, 0.5, CARD_WIDTH - 1, CARD_HEIGHT - 1, CARD_RADIUS)
  ctx.stroke()

  return canvas.encode('png')
}

function ellipsize(ctx: SKRSContext2D, text: string, maxWidth: number): string {
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
