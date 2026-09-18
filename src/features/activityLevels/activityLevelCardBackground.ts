import {
  CARD_HEIGHT,
  CARD_WIDTH,
  COLOR_AVATAR_HALO,
  COLOR_BG_BOTTOM,
  COLOR_BG_TOP,
  COLOR_MOON,
  COLOR_MOON_HALO,
} from './activityLevelCardTheme'
import { type SKRSContext2D } from '@napi-rs/canvas'

export function drawNightBackground(
  ctx: SKRSContext2D,
  width: number = CARD_WIDTH,
  height: number = CARD_HEIGHT
): void {
  const bg = ctx.createLinearGradient(0, 0, 0, height)
  bg.addColorStop(0, COLOR_BG_TOP)
  bg.addColorStop(1, COLOR_BG_BOTTOM)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)

  // Soft night glow behind avatar (left, vertically centered)
  const glow = ctx.createRadialGradient(
    230,
    height / 2,
    20,
    230,
    height / 2,
    520
  )
  glow.addColorStop(0, COLOR_AVATAR_HALO)
  glow.addColorStop(1, 'rgba(122, 162, 255, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, width, height)

  drawStars(ctx)
  drawMoon(ctx, width)
  drawHorizon(ctx, width, height)

  // Top accent line
  const accentLine = ctx.createLinearGradient(0, 0, width, 0)
  accentLine.addColorStop(0, 'rgba(122, 162, 255, 0.7)')
  accentLine.addColorStop(1, 'rgba(122, 162, 255, 0)')
  ctx.fillStyle = accentLine
  ctx.fillRect(0, 0, width, 4)
}

function drawStars(ctx: SKRSContext2D): void {
  // Deterministic star field (no RNG so renders are stable)
  const stars: ReadonlyArray<readonly [number, number, number]> = [
    [90, 60, 2.2],
    [180, 130, 1.4],
    [300, 50, 1.7],
    [420, 110, 1.1],
    [540, 80, 1.9],
    [660, 140, 1.3],
    [780, 60, 1.6],
    [900, 120, 2.0],
    [1020, 55, 1.4],
    [1140, 95, 1.7],
    [1260, 70, 1.3],
    [1380, 130, 1.6],
    [240, 210, 1.1],
    [500, 195, 1.4],
    [780, 220, 1.3],
    [1080, 205, 1.6],
    [1360, 195, 1.1],
  ]
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
  for (const [x, y, r] of stars) {
    ctx.globalAlpha = 0.4 + ((x * 7 + y * 3) % 50) / 100
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

function drawMoon(ctx: SKRSContext2D, width: number): void {
  const cx = width - 150
  const cy = 130
  const radius = 56

  // Halo
  const halo = ctx.createRadialGradient(cx, cy, 12, cx, cy, radius * 3)
  halo.addColorStop(0, COLOR_MOON_HALO)
  halo.addColorStop(1, 'rgba(244, 241, 216, 0)')
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(cx, cy, radius * 3, 0, Math.PI * 2)
  ctx.fill()

  // Moon body
  ctx.fillStyle = COLOR_MOON
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fill()

  // Crescent shadow
  ctx.fillStyle = COLOR_BG_TOP
  ctx.beginPath()
  ctx.arc(cx + radius * 0.45, cy - radius * 0.1, radius * 0.92, 0, Math.PI * 2)
  ctx.fill()
}

function drawHorizon(ctx: SKRSContext2D, width: number, height: number): void {
  // Distant mountain silhouette near bottom
  ctx.fillStyle = 'rgba(8, 12, 30, 0.55)'
  ctx.beginPath()
  ctx.moveTo(0, height)
  ctx.lineTo(0, height - 100)
  ctx.lineTo(180, height - 150)
  ctx.lineTo(360, height - 115)
  ctx.lineTo(540, height - 165)
  ctx.lineTo(720, height - 130)
  ctx.lineTo(900, height - 180)
  ctx.lineTo(1080, height - 140)
  ctx.lineTo(1260, height - 165)
  ctx.lineTo(width, height - 125)
  ctx.lineTo(width, height)
  ctx.closePath()
  ctx.fill()

  // Soft cloud band
  const cloud = ctx.createLinearGradient(0, height - 200, 0, height)
  cloud.addColorStop(0, 'rgba(122, 162, 255, 0)')
  cloud.addColorStop(0.5, 'rgba(122, 162, 255, 0.06)')
  cloud.addColorStop(1, 'rgba(122, 162, 255, 0)')
  ctx.fillStyle = cloud
  ctx.fillRect(0, height - 200, width, 200)
}
