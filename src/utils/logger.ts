import { type ColorName, colorize } from './colors'
import { createLogger, format, transports } from 'winston'

export type LogLevel = 'DEBUG' | 'ERROR' | 'INFO' | 'WARN'

export type LogSinkOutput = {
  readonly category: string
  readonly elapsedMs: number
  readonly message: string
}

export type LogSink = (output: LogSinkOutput) => void

let customSink: LogSink | undefined
let debugEnabled = false
let clockStart: number

function resetClock(): void {
  clockStart = Date.now()
}

resetClock()

export function resetLogClockForTests(): void {
  resetClock()
}

const LEVEL_COLORS: Record<LogLevel, ColorName> = {
  DEBUG: 'gray',
  ERROR: 'red',
  INFO: 'green',
  WARN: 'yellow',
}

const WINSTON_LEVEL_MAP: Record<LogLevel, string> = {
  DEBUG: 'debug',
  ERROR: 'error',
  INFO: 'info',
  WARN: 'warn',
}

const winstonLogger = createLogger({
  level: 'debug',
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  },
  format: format.combine(format.timestamp(), format.errors({ stack: true })),
  transports: [
    new transports.Console({
      format: format.printf((info) => {
        const level = (info.level as string).toUpperCase() as LogLevel
        const elapsedMs = (info as { elapsedMs?: number }).elapsedMs ?? 0
        const category = (info as { category?: string }).category ?? ''
        const message = (info as { message?: string }).message ?? ''
        const sinkOutput: LogSinkOutput = {
          category,
          elapsedMs,
          message,
        }
        if (customSink !== undefined) {
          customSink(sinkOutput)
          return ''
        }
        const levelColored = colorize(`[${level}]`, LEVEL_COLORS[level])
        const elapsed = colorize(`[+${elapsedMs}ms]`, 'gray')
        const categoryColored = colorize(`[${category}]`, 'cyan')
        const messageColored = colorize(message, 'white')
        return `${levelColored} ${elapsed} ${categoryColored} ${messageColored}`
      }),
    }),
  ],
})

function emit(level: LogLevel, category: string, message: string): void {
  if (level === 'DEBUG' && !debugEnabled) {
    return
  }

  const elapsedMs = Date.now() - clockStart

  // winston LogEntry 타입과 커스텀 payload 타입 불일치
  winstonLogger.log({
    level: WINSTON_LEVEL_MAP[level],
    message,
    category,
    elapsedMs,
  } as never)
}

export type FullMoonLogger = {
  readonly debug: (category: string, message: string) => void
  readonly error: (category: string, message: string) => void
  readonly info: (category: string, message: string) => void
  readonly setDebug: (enabled: boolean) => void
  readonly warn: (category: string, message: string) => void
}

export const logger: FullMoonLogger = {
  debug: (category, message) => emit('DEBUG', category, message),
  error: (category, message) => emit('ERROR', category, message),
  info: (category, message) => emit('INFO', category, message),
  setDebug: (enabled) => {
    debugEnabled = enabled
  },
  warn: (category, message) => emit('WARN', category, message),
}

export function setLogSink(sink: LogSink | undefined): void {
  customSink = sink
}
