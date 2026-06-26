export const colors = {
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  white: '\x1b[37m',
  yellow: '\x1b[33m',
} as const

export type ColorName = keyof typeof colors

export function colorize(text: string, color: ColorName): string {
  return `${colors[color]}${text}${colors.reset}`
}
