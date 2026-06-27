export type SearchQueryResult = {
  readonly query: string
  readonly source?: string
}

export type TrackInfo = {
  readonly author: string
  readonly durationMs: number
  readonly title: string
}

export type IndexedTrack = TrackInfo & {
  readonly index: number
}

export type QueuePage = {
  readonly currentPage: number
  readonly tracks: readonly TrackInfo[]
  readonly totalPages: number
}

export type PaginateOptions = {
  readonly page: number
  readonly perPage: number
}

export type RepeatMode = 'off' | 'queue' | 'track'

const urlPattern = /^https?:\/\//i

export function buildSearchQuery(input: string): SearchQueryResult {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    throw new Error('검색어를 입력해 주세요.')
  }

  if (urlPattern.test(trimmed)) {
    return { query: trimmed }
  }

  return { query: trimmed, source: 'ytsearch' }
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const mm = minutes.toString().padStart(2, '0')
  const ss = seconds.toString().padStart(2, '0')

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`
  }

  return `${mm}:${ss}`
}

export function formatTrackLine(track: IndexedTrack): string {
  return `\`${track.index}.\` **${track.title}** — ${
    track.author
  } \`${formatDuration(track.durationMs)}\``
}

export function paginateQueue(
  tracks: readonly TrackInfo[],
  options: PaginateOptions
): QueuePage {
  if (tracks.length === 0) {
    return { currentPage: 0, tracks: [], totalPages: 0 }
  }

  const totalPages = Math.ceil(tracks.length / options.perPage)
  const safePage = Math.min(Math.max(0, options.page), totalPages - 1)
  const start = safePage * options.perPage
  const pageTracks = tracks.slice(start, start + options.perPage)

  return {
    currentPage: safePage,
    tracks: pageTracks,
    totalPages,
  }
}

export function formatQueuePage(page: QueuePage): string {
  if (page.tracks.length === 0) {
    return '대기열이 비어 있어요.'
  }

  const header = `**대기열 (${page.currentPage + 1}/${
    page.totalPages
  } 페이지)**`
  const lines = page.tracks.map((track, i) =>
    formatTrackLine({
      author: track.author,
      durationMs: track.durationMs,
      index: page.currentPage * 10 + i + 1,
      title: track.title,
    })
  )

  return [header, ...lines].join('\n')
}

export function parseSeekInput(input: string): number {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    throw new Error('시간 형식이 올바르지 않아요. 예: 1:30 또는 90 (초)')
  }

  const parts = trimmed.split(':')
  if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error('시간 형식이 올바르지 않아요. 예: 1:30 또는 90 (초)')
  }

  const numbers = parts.map((part) => Number.parseInt(part, 10))
  const seconds = numbers.reduce((acc, value) => acc * 60 + value, 0)
  return seconds * 1000
}
