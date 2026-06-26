export const KOREA_TIME_ZONE = 'Asia/Seoul' as const
export const KOREAN_LOCALE = 'ko-KR' as const
export const DISCORD_KOREAN_LOCALE = 'ko' as const

const dateTimeFormatter = new Intl.DateTimeFormat(KOREAN_LOCALE, {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: KOREA_TIME_ZONE,
})

const wonFormatter = new Intl.NumberFormat(KOREAN_LOCALE, {
  currency: 'KRW',
  maximumFractionDigits: 0,
  style: 'currency',
})

export function formatKoreanDateTime(date: Date): string {
  return dateTimeFormatter.format(date)
}

export function formatWon(amount: number): string {
  return wonFormatter.format(amount)
}
