import { GlobalFonts } from '@napi-rs/canvas'
import path from 'node:path'

// Card dimensions
export const CARD_WIDTH = 1500
export const CARD_HEIGHT = 530
export const CARD_RADIUS = 28

// Night palette
export const COLOR_BG_TOP = '#0a0f24'
export const COLOR_BG_BOTTOM = '#10183a'
export const COLOR_NIGHT_GLOW = '#1b2a5a'
export const COLOR_MOON = '#f4f1d8'
export const COLOR_MOON_HALO = 'rgba(244, 241, 216, 0.18)'
export const COLOR_AVATAR_RING = '#7aa2ff'
export const COLOR_AVATAR_HALO = 'rgba(122, 162, 255, 0.35)'
export const COLOR_DIVIDER = 'rgba(255, 255, 255, 0.12)'
export const COLOR_HEADING = '#cdd6ff'
export const COLOR_LABEL = '#9fb0d8'
export const COLOR_VALUE = '#FFFFFF'
export const COLOR_ACCENT = '#7aa2ff'
export const COLOR_BORDER = 'rgba(255, 255, 255, 0.06)'

// Font family names registered with GlobalFonts
export const FONT_FAMILY = 'Pretendard'
export const FONT_FAMILY_BOLD = 'Pretendard Bold'
export const FONT_FAMILY_EXTRABOLD = 'Pretendard ExtraBold'

let fontsRegistered = false

export function ensureActivityLevelCardFontsRegistered(): void {
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
