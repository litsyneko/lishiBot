import { drawNightBackground } from './activityLevelCardBackground'
import {
  drawAvatar,
  drawAvatarHaloRing,
  drawTrackRow,
  ellipsize,
  fetchAvatar,
  formatDuration,
  roundRectPath,
} from './activityLevelCardDrawing'
import {
  CARD_HEIGHT,
  CARD_RADIUS,
  CARD_WIDTH,
  COLOR_BORDER,
  COLOR_DIVIDER,
  COLOR_HEADING,
  COLOR_LABEL,
  FONT_FAMILY,
  FONT_FAMILY_BOLD,
  FONT_FAMILY_EXTRABOLD,
  ensureActivityLevelCardFontsRegistered,
} from './activityLevelCardTheme'
import type { TextLevelStats, VoiceLevelStats } from './activityLevels'
import { createCanvas } from '@napi-rs/canvas'

export type ActivityLevelCardInput = {
  readonly username: string
  readonly avatarUrl: string
  readonly text: TextLevelStats
  readonly voice: VoiceLevelStats
}

export async function renderActivityLevelCard(
  input: ActivityLevelCardInput
): Promise<Buffer> {
  ensureActivityLevelCardFontsRegistered()

  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT)
  const ctx = canvas.getContext('2d')

  // ---- Card clip + night background ----
  roundRectPath(ctx, 0, 0, CARD_WIDTH, CARD_HEIGHT, CARD_RADIUS)
  ctx.save()
  ctx.clip()
  drawNightBackground(ctx, CARD_WIDTH, CARD_HEIGHT)
  ctx.restore()

  // ---- Avatar (left) ----
  const avatarCx = 230
  const avatarCy = CARD_HEIGHT / 2
  const avatarDiameter = 340
  drawAvatarHaloRing(ctx, avatarCx, avatarCy, avatarDiameter)
  const image = await fetchAvatar(input.avatarUrl)
  drawAvatar(ctx, image, avatarCx, avatarCy, avatarDiameter, input.username)

  // ---- Vertical divider ----
  const dividerX = 420
  const dividerGrad = ctx.createLinearGradient(0, 80, 0, CARD_HEIGHT - 80)
  dividerGrad.addColorStop(0, 'rgba(255, 255, 255, 0)')
  dividerGrad.addColorStop(0.5, COLOR_DIVIDER)
  dividerGrad.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = dividerGrad
  ctx.fillRect(dividerX, 80, 2, CARD_HEIGHT - 160)

  // ---- Right section ----
  const rightX = dividerX + 60
  const rightW = CARD_WIDTH - rightX - 70

  // Heading: 레벨
  ctx.fillStyle = COLOR_HEADING
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `bold 46px ${FONT_FAMILY_EXTRABOLD}`
  ctx.fillText('레벨', rightX, 110)

  // Username under heading
  ctx.fillStyle = COLOR_LABEL
  ctx.font = `600 26px ${FONT_FAMILY_BOLD}`
  const nameText = ellipsize(ctx, input.username, rightW)
  ctx.fillText(nameText, rightX, 150)

  // 채팅 row
  drawTrackRow(
    ctx,
    rightX,
    225,
    rightW,
    '채팅',
    input.text.level,
    input.text.xp,
    input.text.xpNeeded,
    `${input.text.messageCount.toLocaleString()}메시지`
  )

  // 보이스 row
  const voiceMetric = `${formatDuration(
    input.voice.totalSeconds
  )} · 세션 ${input.voice.sessionCount.toLocaleString()}회`
  drawTrackRow(
    ctx,
    rightX,
    385,
    rightW,
    '보이스',
    input.voice.level,
    input.voice.xp,
    input.voice.xpNeeded,
    voiceMetric
  )

  // ---- Watermark ----
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)'
  ctx.font = `500 16px ${FONT_FAMILY}`
  ctx.fillText('Lisy', CARD_WIDTH - 28, CARD_HEIGHT - 22)

  // ---- Outer border ----
  ctx.strokeStyle = COLOR_BORDER
  ctx.lineWidth = 1
  roundRectPath(ctx, 0.5, 0.5, CARD_WIDTH - 1, CARD_HEIGHT - 1, CARD_RADIUS)
  ctx.stroke()

  return canvas.encode('png')
}
