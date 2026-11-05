import { createHmac } from 'node:crypto'
import { logger } from '../utils/logger'

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

export interface MusicPlatformOption {
  name: string
  label: string
}

export const MUSIC_PLATFORMS: readonly MusicPlatformOption[] = [
  { name: 'ytsearch', label: '유튜브' },
  { name: 'ytmsearch', label: '유튜브 뮤직' },
  { name: 'spsearch', label: '스포티파이' },
]

export function findMusicPlatform(
  value: unknown
): MusicPlatformOption['name'] | undefined {
  if (value === undefined) return undefined
  return MUSIC_PLATFORMS.find((p) => p.name === value)?.name
}

/**
 * Spotify 트랙 검색/임베드 스크래핑 결과의 공통 형태.
 * 유튜브 뮤직 매칭(유튜브 음원으로 재생)에 필요한 메타데이터만 담는다.
 */
export type SpotifyResolvedTrack = {
  title: string
  author: string
  durationMs: number
  uri?: string
  artworkUrl?: string
}

export type SpotifyResolvedMetadata = {
  kind: 'track' | 'collection'
  name: string
  uri: string
  artworkUrl?: string
  tracks: SpotifyResolvedTrack[]
}

const SPOTIFY_URL_RE =
  /^https?:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i

export function isSpotifyCollectionUrl(url: string): boolean {
  return /^https?:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?(album|playlist)\/[A-Za-z0-9]+/i.test(
    url
  )
}

export function isSpotifyUrl(url: string): boolean {
  return SPOTIFY_URL_RE.test(url)
}

function spotifyUriToWebUrl(uri: unknown): string | undefined {
  if (typeof uri !== 'string') return undefined
  const m = /^spotify:(track|album|playlist):([A-Za-z0-9]+)$/i.exec(uri)
  if (m !== null) {
    return `https://open.spotify.com/${m[1].toLowerCase()}/${m[2]}`
  }
  if (/^https?:\/\/open\.spotify\.com\//i.test(uri)) {
    return uri
  }
  return undefined
}

type SpotifyCoverEntity = {
  coverArt?: {
    sources?: { url?: unknown }[]
  }
  visualIdentity?: {
    image?: { url?: unknown }[]
  }
}

function extractCoverArtUrl(entity: SpotifyCoverEntity): string | undefined {
  const sources = entity.coverArt?.sources ?? []
  const first = sources.find((s) => typeof s.url === 'string')
  if (first?.url !== undefined) return first.url as string

  const viImages = entity.visualIdentity?.image ?? []
  const viFirst = viImages.find((s) => typeof s.url === 'string')
  return viFirst?.url as string | undefined
}

function parseSpotifyDuration(value: unknown): number {
  // Spotify embed entities report duration in milliseconds
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value))
  }
  if (typeof value === 'string') {
    const parts = value.split(':').map((p) => Number.parseInt(p, 10))
    if (parts.length > 0 && parts.every((p) => Number.isFinite(p))) {
      return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000
    }
  }
  return 0
}

type SpotifyEmbedEntity = SpotifyCoverEntity & {
  name?: string
  title?: string
  subtitle?: string
  duration?: unknown
  uri?: unknown
  artists?: { name?: unknown }[]
  trackList?: {
    title?: string
    subtitle?: string
    duration?: unknown
    uri?: unknown
  }[]
}

function entityToTracks(
  entity: SpotifyEmbedEntity,
  fallbackArtworkUrl?: string
): SpotifyResolvedTrack[] {
  const tracks: SpotifyResolvedTrack[] = []
  for (const t of entity.trackList ?? []) {
    const title = t.title ?? ''
    const author = t.subtitle ?? ''
    if (title.length === 0) continue
    tracks.push({
      title,
      author: author.length > 0 ? author : '알 수 없음',
      durationMs: parseSpotifyDuration(t.duration),
      uri: spotifyUriToWebUrl(t.uri),
      artworkUrl: fallbackArtworkUrl,
    })
  }
  return tracks
}

async function fetchText(url: string, timeoutMs = 10000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
      signal: controller.signal,
    })
    if (!res.ok) return ''
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

let cachedSpotifyAnonToken: { token: string; expiresAt: number } | null = null

// ── Spotify partner GraphQL (비공식 web-player 클라이언트 API) ─────────────
// 컬렉션(플레이리스트/앨범) embed 페이지가 2026-11부터 404로 죽었고 익명 API
// 검색도 QUOTA_EXCEEDED 429로 막혀서, web-player가 쓰는 TOTP 게스트 토큰 +
// api-partner pathfinder GraphQL(유지된 persisted query)을 사용한다.
const SPOTIFY_TOTP_SECRET =
  'GM3TMMJTGYZTQNZVGM4DINJZHA4TGOBYGMZTCMRTGEYDSMJRHE4TEOBUG4YTCMRUGQ4D' +
  'QOJUGQYTAMRRGA2TCMJSHE3TCMBY'
const SPOTIFY_TOTP_VERSION = 61
const SPOTIFY_PARTNER_QUERY_URL =
  'https://api-partner.spotify.com/pathfinder/v2/query'
const SPOTIFY_PARTNER_HASHES = {
  playlist: 'bb67e0af06e8d6f52b531f97468ee4acd44cd0f82b988e15c2ea47b1148efc77',
  album: 'ce390dbf7ca6b61a23aec210619e1094fe9d23d7f101ff773ce1146f84d4dd10',
  search: '75bbf6bfcfdf85b8fc828417bfad92b7cd66bf7f556d85670f4da8292373ebec',
} as const

const SPOTIFY_PARTNER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'

type SpotifyIterableSources = { url?: unknown; width?: unknown }[] | undefined

function pickLargestCoverArt(
  sources: SpotifyIterableSources
): string | undefined {
  if (sources === undefined) return undefined
  let best: { url: string; width: number } | undefined
  for (const source of sources) {
    if (typeof source?.url !== 'string' || source.url.length === 0) continue
    const width = typeof source.width === 'number' ? source.width : 0
    if (best === undefined || width > best.width) {
      best = { url: source.url, width }
    }
  }
  return best?.url
}

type SpotifyPartnerTrackNode = {
  uri?: unknown
  name?: unknown
  duration?: { totalMilliseconds?: unknown }
  trackDuration?: { totalMilliseconds?: unknown }
  artists?: {
    items?: { profile?: { name?: unknown }; uri?: unknown }[]
  }
  albumOfTrack?: {
    name?: unknown
    coverArt?: { sources?: SpotifyIterableSources }
  }
  playability?: { playable?: unknown }
}

function partnerArtistLine(node: {
  artists?: {
    items?: { profile?: { name?: unknown } }[]
  }
}): string {
  const names =
    node.artists?.items
      ?.map((a) =>
        typeof a.profile?.name === 'string' ? a.profile?.name : undefined
      )
      .filter((n): n is string => n !== undefined && n.length > 0) ?? []
  if (names.length === 0) return '알 수 없음'
  return names.join(', ')
}

function partnerTrackToResolved(
  node: SpotifyPartnerTrackNode
): SpotifyResolvedTrack | null {
  const title = typeof node.name === 'string' ? node.name : undefined
  if (title === undefined || title.length === 0) return null
  if (node.playability !== undefined && node.playability.playable !== true) {
    return null
  }
  const durationMs =
    (node.trackDuration?.totalMilliseconds ??
      node.duration?.totalMilliseconds ??
      0) as number
  return {
    title,
    author: partnerArtistLine(node),
    durationMs: typeof durationMs === 'number' ? Math.max(0, Math.round(durationMs)) : 0,
    uri: spotifyUriToWebUrl(node.uri),
    artworkUrl: pickLargestCoverArt(
      node.albumOfTrack?.coverArt?.sources ?? undefined
    ),
  }
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >>> bits) & 0xff)
    }
  }
  return Buffer.from(bytes) as unknown as Buffer
}

/** web-player TOTP(30초 SHA1 6자리) 코드 생성 — SpotiFLAC 계열 비공식 시크릿 */
function spotifyTotpCode(): string {
  const step = Math.floor(Date.now() / 1000 / 30)
  const buffer = Buffer.alloc(8)
  buffer.writeUInt32BE(Math.floor(step / 2 ** 32), 0)
  buffer.writeUInt32BE(step >>> 0, 4)
  const key = Buffer.from(base32Decode(SPOTIFY_TOTP_SECRET))
  const mac = createHmac('sha1', key).update(buffer).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3]
  return String(bin % 1e6).padStart(6, '0')
}

let cachedSpotifyPartnerToken: { token: string; expiresAt: number } | null = null

async function getSpotifyPartnerToken(): Promise<string | null> {
  const now = Date.now()
  if (
    cachedSpotifyPartnerToken !== null &&
    cachedSpotifyPartnerToken.expiresAt > now + 60_000
  ) {
    return cachedSpotifyPartnerToken.token
  }

  try {
    const code = spotifyTotpCode()
    const url = new URL('https://open.spotify.com/api/token')
    url.searchParams.set('reason', 'init')
    url.searchParams.set('productType', 'web-player')
    url.searchParams.set('totp', code)
    url.searchParams.set('totpVer', String(SPOTIFY_TOTP_VERSION))
    url.searchParams.set('cTime', String(Math.floor(now / 1000)))
    url.searchParams.set('cVer', '1')
    const res = await fetch(url, { headers: { 'User-Agent': SPOTIFY_PARTNER_UA } })
    if (!res.ok) {
      logSpotifyError(
        'partnerToken',
        new Error(`HTTP ${res.status} ${res.statusText}`)
      )
      return null
    }
    const body = (await res.json()) as {
      accessToken?: unknown
      accessTokenExpirationTimestampMs?: unknown
    }
    if (typeof body.accessToken === 'string' && body.accessToken.length > 0) {
      const expiresAt =
        typeof body.accessTokenExpirationTimestampMs === 'number' &&
        body.accessTokenExpirationTimestampMs > 0
          ? body.accessTokenExpirationTimestampMs
          : now + 845_000
      cachedSpotifyPartnerToken = { token: body.accessToken, expiresAt }
      return body.accessToken
    }
  } catch (error) {
    logSpotifyError('partnerToken', error)
  }
  return null
}

async function partnerQuery(
  operationName: string,
  hash: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  let token = await getSpotifyPartnerToken()
  if (token === null) return null

  const request = async (): Promise<Response | null> => {
    try {
      return await fetch(SPOTIFY_PARTNER_QUERY_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token ?? ''}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'App-Platform': 'WebPlayer',
          'Spotify-App-Version': '1.0.0',
          'User-Agent': SPOTIFY_PARTNER_UA,
        },
        body: JSON.stringify({
          operationName,
          variables,
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        }),
      })
    } catch (error) {
      logSpotifyError('partnerQuery', error)
      return null
    }
  }

  let res = await request()
  if (res !== null && res.status === 401) {
    cachedSpotifyPartnerToken = null
    token = await getSpotifyPartnerToken()
    if (token === null) return null
    res = await request()
  }
  if (res === null || !res.ok) {
    logSpotifyError(
      'partnerQuery',
      new Error(
        `${operationName} HTTP ${res !== null ? res.status : 'no-response'}`
      )
    )
    return null
  }

  try {
    const body = (await res.json()) as Record<string, unknown>
    const data = body.data as Record<string, unknown> | undefined
    if (data === undefined) return null
    return data
  } catch (error) {
    logSpotifyError('partnerQuery', error)
    return null
  }
}

/** 유튜브 뮤직 매칭 텍스트 검색이 아니라 '스포티파이 곡명→메타데이터' 검색:
 * partner searchDesktop persisted query (JSON trees: search.tracks[].track) */
async function searchSpotifyTracksPartner(
  query: string,
  limit: number
): Promise<SpotifyResolvedTrack[]> {
  const data = await partnerQuery('searchDesktop', SPOTIFY_PARTNER_HASHES.search, {
    searchTerm: query,
    offset: 0,
    limit,
    numberOfTopResults: Math.min(limit, 5),
    includeAudiobooks: false,
  })
  if (data === null) return []

  const search = data.search as
    | {
        tracks?: {
          items?: {
            track?: SpotifyPartnerTrackNode | null
          }[]
        }
      }
    | undefined
  const items = search?.tracks?.items ?? []
  const tracks: SpotifyResolvedTrack[] = []
  for (const item of items) {
    if (item.track === null || item.track === undefined) continue
    const resolved = partnerTrackToResolved(item.track)
    if (resolved !== null) tracks.push(resolved)
  }
  return tracks
}

type SpotifyPlaylistPage = {
  playlistV2?: {
    name?: unknown
    coverArt?: { sources?: SpotifyIterableSources }
    content?: {
      items?: { itemV2?: { data?: SpotifyPartnerTrackNode | null } }[]
      totalCount?: unknown
      offset?: unknown
    }
  } | null
}

async function fetchSpotifyPlaylistPartner(
  playlistId: string
): Promise<{ name: string; artworkUrl?: string; tracks: SpotifyResolvedTrack[] } | null> {
  const tracks: SpotifyResolvedTrack[] = []
  let name = ''
  let artworkUrl: string | undefined
  const perPage = 500
  let offset = 0

  for (let page = 0; page < 8; page += 1) {
    const data = (await partnerQuery(
      'fetchPlaylist',
      SPOTIFY_PARTNER_HASHES.playlist,
      {
        uri: `spotify:playlist:${playlistId}`,
        offset,
        limit: perPage,
        enableWatchFeedEntrypoint: false,
      }
    )) as SpotifyPlaylistPage | null

    const playlist = data?.playlistV2
    if (playlist === undefined || playlist === null) break
    if (typeof playlist.name === 'string' && playlist.name.length > 0) {
      name = playlist.name
    }
    const cover = pickLargestCoverArt(playlist.coverArt?.sources)
    if (artworkUrl === undefined) artworkUrl = cover

    const pageItems = playlist.content?.items ?? []
    for (const pageItem of pageItems) {
      const node = pageItem.itemV2?.data
      if (node === null || node === undefined) continue
      const resolved = partnerTrackToResolved(node)
      if (resolved !== null) tracks.push(resolved)
    }
    const total = playlist.content?.totalCount
    if (
      pageItems.length === 0 ||
      (typeof total === 'number' && offset + pageItems.length >= total) ||
      pageItems.length < perPage
    ) {
      break
    }
    offset += pageItems.length
  }

  if (tracks.length === 0 && name.length === 0) return null
  return { name, artworkUrl, tracks }
}

type SpotifyAlbumPage = {
  albumUnion?: {
    name?: unknown
    coverArt?: { sources?: SpotifyIterableSources }
    tracksV2?: {
      items?: { track?: SpotifyPartnerTrackNode | null }[]
      totalCount?: unknown
      offset?: unknown
    } | null
  } | null
}

async function fetchSpotifyAlbumPartner(
  albumId: string
): Promise<{ name: string; artworkUrl?: string; tracks: SpotifyResolvedTrack[] } | null> {
  const data = (await partnerQuery('queryAlbum', SPOTIFY_PARTNER_HASHES.album, {
    uri: `spotify:album:${albumId}`,
    offset: 0,
  })) as SpotifyAlbumPage | null

  const album = data?.albumUnion
  if (album === undefined || album === null) return null

  const name = typeof album.name === 'string' ? album.name : ''
  const artworkUrl = pickLargestCoverArt(album.coverArt?.sources)
  const tracks: SpotifyResolvedTrack[] = []
  for (const item of album.tracksV2?.items ?? []) {
    if (item.track === null || item.track === undefined) continue
    const resolved = partnerTrackToResolved(item.track)
    if (resolved !== null) tracks.push(resolved)
  }
  if (tracks.length === 0 && name.length === 0) return null
  return { name, artworkUrl, tracks }
}

async function getSpotifyToken(): Promise<string | null> {
  const partnerToken = await getSpotifyPartnerToken()
  if (partnerToken !== null) return partnerToken
  return getSpotifyAnonymousToken()
}

async function getSpotifyAnonymousToken(): Promise<string | null> {
  const now = Date.now()
  if (
    cachedSpotifyAnonToken !== null &&
    cachedSpotifyAnonToken.expiresAt > now + 60_000
  ) {
    return cachedSpotifyAnonToken.token
  }

  const html = await fetchText(
    'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT'
  )
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (match === null) return null

  try {
    const data = JSON.parse(match[1]) as {
      props?: {
        pageProps?: {
          state?: {
            settings?: {
              session?: {
                accessToken?: unknown
                accessTokenExpirationTimestampMs?: unknown
              }
            }
          }
        }
      }
    }
    const session = data.props?.pageProps?.state?.settings?.session
    const token = session?.accessToken
    const exp = (session?.accessTokenExpirationTimestampMs as number) ?? now + 1800_000
    if (typeof token === 'string' && token.length > 0) {
      cachedSpotifyAnonToken = { token, expiresAt: exp }
      return token
    }
  } catch {
    return null
  }

  return null
}

export async function searchSpotifyTracks(
  query: string,
  limit = 5
): Promise<SpotifyResolvedTrack[]> {
  // 1) partner GraphQL (컬렉션 embed 사망 이후의 표준 경로)
  const partnerTracks = await searchSpotifyTracksPartner(query, limit)
  if (partnerTracks.length > 0) return partnerTracks

  // 2) 폴백: 익명 토큰 + REST (/v1 자체가 QUOTA_EXCEEDED일 수 있음)
  const token = await getSpotifyToken()
  if (token === null) return []

  try {
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(
      query
    )}&type=track&limit=${limit}&market=KR`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Mozilla/5.0',
      },
    })
    if (!res.ok) return []

    const body = (await res.json()) as {
      tracks?: {
        items?: {
          name?: string
          uri?: string
          duration_ms?: number
          artists?: { name?: string }[]
          external_urls?: { spotify?: string }
          album?: { images?: { url?: string }[] }
        }[]
      }
    }
    const items = body.tracks?.items ?? []
    const tracks: SpotifyResolvedTrack[] = []
    for (const item of items) {
      const title = item.name ?? ''
      if (title.length === 0) continue
      const author = item.artists?.[0]?.name ?? '알 수 없음'
      const uri = item.external_urls?.spotify ?? spotifyUriToWebUrl(item.uri)
      const artworkUrl = item.album?.images?.[0]?.url
      tracks.push({
        title,
        author,
        durationMs: item.duration_ms ?? 0,
        uri,
        artworkUrl,
      })
    }
    return tracks
  } catch {
    return []
  }
}

function extractEntity(html: string): SpotifyEmbedEntity | null {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (match === null) return null

  try {
    const data = JSON.parse(match[1]) as {
      props?: {
        pageProps?: {
          entity?: SpotifyEmbedEntity
          state?: {
            data?: {
              entity?: SpotifyEmbedEntity
            }
          }
        }
      }
    }
    const pageProps = data.props?.pageProps
    if (pageProps?.entity !== undefined) return pageProps.entity
    const stateEntity = pageProps?.state?.data?.entity
    if (stateEntity !== undefined) return stateEntity
  } catch {
    return null
  }

  return null
}

type SpotifyOembed = {
  title?: string
  thumbnail_url?: string
}

async function fetchSpotifyOembed(url: string): Promise<SpotifyOembed | null> {
  try {
    const res = await fetch(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    )
    if (!res.ok) return null
    return (await res.json()) as SpotifyOembed
  } catch {
    return null
  }
}

/**
 * Resolves a single Spotify track URL into its own cover image URL.
 * Used lazily right before playback so playlist tracks show their own album art.
 */
export async function resolveSpotifyTrackArtwork(
  trackUrl: string
): Promise<string | undefined> {
  const match = SPOTIFY_URL_RE.exec(trackUrl)
  if (match === null) return undefined

  const [, kindRaw, id] = match
  const kind = kindRaw.toLowerCase()
  if (kind !== 'track') return undefined

  const canonicalUrl = `https://open.spotify.com/track/${id}`
  const oembed = await fetchSpotifyOembed(canonicalUrl)
  if (
    oembed?.thumbnail_url !== undefined &&
    oembed.thumbnail_url.length > 0
  ) {
    return oembed.thumbnail_url
  }

  const embedUrl = `https://open.spotify.com/embed/track/${id}`
  const entity = extractEntity(await fetchText(embedUrl))
  if (entity !== null) {
    return extractCoverArtUrl(entity)
  }

  return undefined
}

/**
 * Spotify URL을 공개 임베드 페이지에서 메타데이터(이름/커버/트랙 목록)로 해석한다.
 * oEmbed 엔드포인트를 폴백으로 사용한다.
 */
export async function resolveSpotifyMetadata(
  url: string
): Promise<SpotifyResolvedMetadata | null> {
  const match = SPOTIFY_URL_RE.exec(url)
  if (match === null) return null

  const [, kindRaw, id] = match
  const kind = kindRaw.toLowerCase()

  const canonicalUrl = `https://open.spotify.com/${kind}/${id}`

  // 1) 컬렉션(플레이리스트/앨범): embed 페이지가 2026-11부터 404로 죽어서
  //    partner GraphQL 경로를 먼저 쓴다.
  if (kind === 'playlist' || kind === 'album') {
    const collection =
      kind === 'playlist'
        ? await fetchSpotifyPlaylistPartner(id)
        : await fetchSpotifyAlbumPartner(id)
    if (collection !== null) {
      return {
        kind: 'collection',
        name: collection.name.length > 0 ? collection.name : canonicalUrl,
        uri: canonicalUrl,
        artworkUrl: collection.artworkUrl,
        tracks: collection.tracks,
      }
    }
    // partner 실패 시 기존 임베드/oEmbed 폴백을 계속 시도한다 (아래 로직).
  }

  const embedUrl = `https://open.spotify.com/embed/${kind}/${id}`

  const entity = extractEntity(await fetchText(embedUrl))
  let artworkUrl: string | undefined

  if (entity !== null) {
    const name = entity.name ?? entity.title ?? ''
    artworkUrl = extractCoverArtUrl(entity)

    if (artworkUrl === undefined) {
      const oembed = await fetchSpotifyOembed(canonicalUrl)
      artworkUrl = oembed?.thumbnail_url
    }

    if (kind === 'track' && name.length > 0) {
      const author =
        entity.subtitle ??
        (typeof entity.artists?.[0]?.name === 'string'
          ? entity.artists[0].name
          : undefined) ??
        '알 수 없음'
      const trackUri = spotifyUriToWebUrl(entity.uri) ?? canonicalUrl
      return {
        kind: 'track',
        name,
        uri: trackUri,
        artworkUrl,
        tracks: [
          {
            title: name,
            author,
            durationMs: parseSpotifyDuration(entity.duration),
            uri: trackUri,
            artworkUrl,
          },
        ],
      }
    }

    // 앨범은 모든 수록곡이 앨범 커버를 공유하고, 플레이리스트는 각 곡이 재생될 때 자기 자신의 커버를 조회하도록 비워둔다.
    const tracks = entityToTracks(entity, kind === 'album' ? artworkUrl : undefined)
    if (tracks.length > 0 && name.length > 0) {
      return {
        kind: 'collection',
        name,
        uri: canonicalUrl,
        artworkUrl,
        tracks,
      }
    }
  }

  const oembed = await fetchSpotifyOembed(canonicalUrl)
  if (oembed !== null && typeof oembed.title === 'string') {
    const finalArtwork = artworkUrl ?? oembed.thumbnail_url
    return {
      kind: 'track',
      name: oembed.title,
      uri: canonicalUrl,
      artworkUrl: finalArtwork,
      tracks: [
        {
          title: oembed.title,
          author: '알 수 없음',
          durationMs: 0,
          uri: canonicalUrl,
          artworkUrl: finalArtwork,
        },
      ],
    }
  }

  return null
}

export async function resolveSpotifyTrackTitle(url: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }
    )
    if (!res.ok) return null

    const data = (await res.json()) as { title?: unknown }
    return typeof data.title === 'string' && data.title.length > 0
      ? data.title
      : null
  } catch {
    return null
  }
}

function logSpotifyError(scope: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error)
  logger.warn(scope, `스포티파이 메타데이터 처리 실패: ${reason}`)
}
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

export { logSpotifyError as _logSpotifyError }
