import {
  type PanelTrackInfo,
  buildPlaylistQueued,
  buildTrackAdded,
} from '../components/musicPanel'
import { createMusicSettingsService } from '../features/music/musicSettings'
import { logger } from '../utils/logger'
import { displayTrackTitle } from '../utils/title'
import type { CustomPlayer } from './customPlayer'
import {
  buildSearchQuery,
  isSpotifyUrl,
  resolveSpotifyMetadata,
  searchSpotifyTracks,
  type SpotifyResolvedTrack,
} from './musicService'
import { pickMatchingYtTrack } from './trackMatching'
import { setVolume } from './volumeStore'
import type { ChatInputCommandInteraction } from 'discord.js'
import { PermissionFlagsBits } from 'discord.js'
import type {
  LavalinkManager,
  SearchPlatform,
  SearchResult,
  Track,
  UnresolvedSearchResult,
  UnresolvedTrack,
} from 'lavalink-client'

const musicSettings = createMusicSettingsService()

export type AudioService = ReturnType<typeof createAudioService>

export function createAudioService(manager: LavalinkManager<CustomPlayer>) {
  /**
   * Gets an existing player or creates a new one for the guild
   * with proper voice options (selfDeaf, instaUpdateFiltersFix).
   */
  async function getOrCreatePlayer(
    guildId: string,
    voiceChannelId: string,
    textChannelId?: string
  ): Promise<CustomPlayer> {
    const existing = manager.getPlayer(guildId)
    if (existing !== undefined) return existing

    const player = await manager.createPlayer({
      guildId,
      voiceChannelId,
      textChannelId: textChannelId ?? '',
      selfDeaf: true,
      selfMute: false,
      instaUpdateFiltersFix: true,
      applyVolumeAsFilter: true,
    })

    const settings = await musicSettings.getSettings(guildId)
    if (settings.volume !== null) {
      setVolume(guildId, settings.volume)
      await player.setVolume(settings.volume)
    }
    if (settings.repeatMode !== null) {
      await player.setRepeatMode(settings.repeatMode)
    }
    if (settings.controllerTab !== null) {
      player.controllerTab = settings.controllerTab
    }
    if (settings.queueVisible !== null) {
      player.queueVisible = settings.queueVisible
    }

    return player
  }

  /**
   * Connects the player to the voice channel.
   * Checks Discord permissions before attempting connection.
   */
  async function connectPlayer(
    player: CustomPlayer,
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (player.connected) return

    const guild = interaction.guild
    if (guild === null) {
      throw new Error('서버 정보를 찾을 수 없어요.')
    }

    const voiceChannel = guild.channels.cache.get(player.voiceChannelId ?? '')
    if (voiceChannel === undefined || !voiceChannel.isVoiceBased()) {
      throw new Error('음성 채널을 찾을 수 없어요.')
    }

    const me = guild.members.me
    if (me !== null) {
      const permissions = voiceChannel.permissionsFor(me)
      if (permissions === null) {
        throw new Error('봇의 권한을 확인할 수 없어요.')
      }
      if (!permissions.has(PermissionFlagsBits.Connect)) {
        throw new Error('봇이 음성 채널에 접속할 권한이 없어요.')
      }
      if (!permissions.has(PermissionFlagsBits.Speak)) {
        throw new Error('봇이 음성 채널에서 말할 권한이 없어요.')
      }
    }

    try {
      await player.connect()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.error(
        'AudioService',
        `음성 채널 연결 실패 (${player.guildId}): ${reason}`
      )
      throw new Error('음성 채널에 접속할 수 없어요.')
    }
  }

  /**
   * Searches for a track or playlist.
   * Handles error and empty load types with user-facing messages.
   */
  async function search(
    player: CustomPlayer,
    query: string,
    requester: unknown,
    platform?: string
  ) {
    // 정책: 스포티파이 강제 재생 중지 → 유튜브 뮤직 미러링
    // (스포티파이 트랙/컬렉션은 유튜브 뮤직에서 제목/아티스트/길이가
    //  같거나 비슷한 트랙을 골라 대입해 재생한다.)
    if (platform === 'spsearch' || isSpotifyUrl(query)) {
      return searchSpotifyMirrored(player, query, requester)
    }

    let searchQuery = buildSearchQuery(query)
    if (
      platform !== undefined &&
      platform !== '' &&
      platform !== 'ytsearch'
    ) {
      searchQuery = {
        query: searchQuery.query,
        source: platform,
      }
    }
    const result = await player.search(
      searchQuery.source !== undefined
        ? {
            query: searchQuery.query,
            source: searchQuery.source as SearchPlatform,
          }
        : { query: searchQuery.query },
      requester
    )

    if (result.loadType === 'error') {
      throw new Error(
        '음악 검색 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.'
      )
    }

    if (result.loadType === 'empty' || result.tracks.length === 0) {
      // ytmsearch가 응답 없이 empty를 내뱉는 문제 대비: ytsearch로 재검색
      if (
        searchQuery.source === 'ytmsearch' ||
        searchQuery.source === 'music'
      ) {
        const yt = await searchYtMusicWithFallback(player, requester, searchQuery.query)
        if (yt.loadType === 'search' && yt.tracks.length > 0) return yt
      }
      throw new Error('검색 결과가 없어요. 다른 검색어로 다시 시도해 주세요.')
    }

    return result
  }

  /** 유튜브 뮤직 검색 — ytmsearch가 응답 없이 empty를 내뱉는 문제(2026-11
   *  실측: ytsearch는 정상, ytmsearch는 무음 empty) 대비 ytsearch 폴백. */
  async function searchYtMusicWithFallback(
    player: CustomPlayer,
    requester: unknown,
    query: string
  ) {
    try {
      const ytm = await player.search(
        { query, source: 'ytmsearch' as SearchPlatform },
        requester
      )
      if (
        ytm.loadType === 'search' &&
        ytm.tracks !== null &&
        ytm.tracks !== undefined &&
        ytm.tracks.length > 0
      ) {
        return ytm
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.debug(
        'AudioService',
        `ytmsearch 비어있음/오류 → ytsearch 폴백 (${query}): ${reason}`
      )
    }
    return player.search({ query, source: 'ytsearch' as SearchPlatform }, requester)
  }

  /**
   * 스포티파이 메타데이터 하나를 유튜브 뮤직 트랙으로 매칭한다.
   * 재생 실패(검색 실패) 시 undefined — 상위에서 건너뛴다.
   */
  async function matchSpotifyToYtMusic(
    player: CustomPlayer,
    requester: unknown,
    spotifyTrack: SpotifyResolvedTrack
  ): Promise<Track | undefined> {
    const ytSearchQueries = [
      `${spotifyTrack.author} - ${spotifyTrack.title}`,
      `${spotifyTrack.title} ${spotifyTrack.author}`,
      spotifyTrack.title,
    ]
    for (const ytSearchQuery of ytSearchQueries) {
      let result
      try {
        result = await searchYtMusicWithFallback(player, requester, ytSearchQuery)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        logger.debug(
          'AudioService',
          `유튜브 뮤직 매칭 검색 실패 (${ytSearchQuery}): ${reason}`
        )
        continue
      }
      if (
        result.loadType !== 'search' ||
        result.tracks === null ||
        result.tracks === undefined ||
        result.tracks.length === 0
      ) {
        continue
      }

      const candidates = result.tracks.map((t) => ({
        track: t,
        title: t.info.title,
        author: t.info.author,
        durationMs: t.info.duration ?? 0,
      }))
      const match = pickMatchingYtTrack(spotifyTrack, candidates)
      if (match.chosen !== undefined) {
        const ytTrack = match.chosen.track as Track
        // 유튜브 뮤직 트랙의 실제 오디오를 재생하되, 화면에는
        // 스포티파이 원본 메타데이터(제목/아티스트/커버)를 노출한다.
        if (spotifyTrack.title.length > 0) {
          ytTrack.info.title = spotifyTrack.title
        }
        if (spotifyTrack.author.length > 0) {
          ytTrack.info.author = spotifyTrack.author
        }
        if (spotifyTrack.artworkUrl !== undefined) {
          ytTrack.info.artworkUrl = spotifyTrack.artworkUrl
        }
        if (spotifyTrack.uri !== undefined) {
          ytTrack.info.uri = spotifyTrack.uri
        }
        if (match.score !== undefined) {
          logger.debug(
            'AudioService',
            `유튜브 뮤직 매칭 [${match.outcome}] score=${match.score.score.toFixed(
              2
            )} — ${spotifyTrack.title} → ${match.chosen.title}`
          )
        }
        return ytTrack
      }
    }
    return undefined
  }

  /**
   * 스포티파이 URL/검색어를 유튜브 뮤직으로 미러링해 결과를 만든다.
   * 컬렉션(앨범/플레이리스트)은 playlist 결과로, 트랙은 search 결과로 돌려준다.
   */
  async function searchSpotifyMirrored(
    player: CustomPlayer,
    query: string,
    requester: unknown
  ) {
    let spotifyTracks: SpotifyResolvedTrack[] = []
    let playlistName: string | undefined = undefined
    let playlistArtworkUrl: string | undefined = undefined

    if (isSpotifyUrl(query)) {
      const meta = await resolveSpotifyMetadata(query)
      if (meta === null) {
        throw new Error(
          '스포티파이 주소를 해석하지 못했어요. 곡 제목으로 다시 시도해 주세요.'
        )
      }
      if (meta.kind === 'collection' && meta.tracks.length > 1) {
        playlistName = meta.name
        playlistArtworkUrl = meta.artworkUrl
      }
      spotifyTracks = meta.tracks.map((t) => ({
        ...t,
        artworkUrl: t.artworkUrl ?? meta.artworkUrl,
      }))
    } else {
      spotifyTracks = await searchSpotifyTracks(query, 3)
    }

    // 스포티파이 메타데이터를 못 구하면 유직으로 직접 검색해 미러링한다.
    if (spotifyTracks.length === 0) {
      const fallback = await searchYtMusicWithFallback(player, requester, query)
      if (
        fallback.loadType === 'error' ||
        fallback.loadType === 'empty' ||
        fallback.tracks.length === 0
      ) {
        throw new Error('검색 결과가 없어요. 다른 검색어로 다시 시도해 주세요.')
      }
      return fallback
    }

    // 동시성 제한(4)으로 유튜브 뮤직 매칭 검색
    const matched: Track[] = []
    for (let i = 0; i < spotifyTracks.length; i += 4) {
      const chunk = spotifyTracks.slice(i, i + 4)
      const results = await Promise.all(
        chunk.map((t) => matchSpotifyToYtMusic(player, requester, t))
      )
      for (const r of results) {
        if (r !== undefined) matched.push(r)
      }
    }

    if (matched.length === 0) {
      throw new Error(
        '스포티파이 트랙을 유튜브 뮤직에서 매칭하지 못했어요. 다른 검색어로 다시 시도해 주세요.'
      )
    }

    if (playlistName !== undefined && matched.length > 1) {
      return {
        loadType: 'playlist',
        playlist: {
          name: playlistName,
          thumbnail: playlistArtworkUrl,
        },
        tracks: matched,
      } as unknown as SearchResult
    }
    return { loadType: 'search' as const, tracks: matched } as SearchResult
  }

  /**
   * Converts a lavalink Track to PanelTrackInfo for UI components.
   */
  function trackToPanelInfo(track: Track | UnresolvedTrack): PanelTrackInfo {
    return {
      title: displayTrackTitle(track.info.title),
      author: track.info.author ?? '알 수 없음',
      durationMs: track.info.duration ?? 0,
      artworkUrl: track.info.artworkUrl ?? undefined,
      identifier: track.info.identifier,
      sourceName: track.info.sourceName,
      uri: track.info.uri,
    }
  }

  /**
   * Handles adding a single track to the queue and replying with an embed.
   */
  async function handleTrackPlay(
    interaction: ChatInputCommandInteraction<'cached'>,
    player: CustomPlayer,
    track: Track | UnresolvedTrack
  ): Promise<void> {
    await player.queue.add(track)

    const isNowPlaying =
      player.queue.current !== null && player.queue.current !== undefined

    const panel = buildTrackAdded({
      track: trackToPanelInfo(track),
      isPlaying: isNowPlaying,
    })

    await interaction.editReply({
      components: panel.components,
      flags: panel.flags,
    })
  }

  /**
   * Handles adding a playlist result to the queue.
   * If a specific track was selected (YouTube playlist with `?v=`), shows
   * an interactive prompt asking if the remaining tracks should be added.
   */
  async function handlePlaylistPlay(
    interaction: ChatInputCommandInteraction<'cached'>,
    player: CustomPlayer,
    searchResult: SearchResult | UnresolvedSearchResult
  ): Promise<void> {
    const tracks = searchResult.tracks.filter(
      (t): t is Track | UnresolvedTrack => t !== null && t !== undefined
    )
    const playlist = searchResult.playlist
    const playlistName = playlist?.name ?? '플레이리스트'

    await player.queue.add(tracks)

    const firstTrack = tracks[0]
    const playlistArtwork =
      playlist?.thumbnail ?? firstTrack?.info.artworkUrl ?? undefined
    const panel = buildPlaylistQueued({
      playlistName,
      trackCount: tracks.length,
      playlistArtworkUrl:
        playlistArtwork !== undefined && playlistArtwork.length > 0
          ? playlistArtwork
          : undefined,
      firstTrack:
        firstTrack !== undefined
          ? trackToPanelInfo(firstTrack)
          : { title: playlistName, author: '알 수 없음', durationMs: 0 },
    })

    await interaction.editReply({
      components: panel.components,
      flags: panel.flags,
    })
  }

  /**
   * Starts playback if the player is not currently playing.
   * Respects the paused state (if paused, resumes instead).
   */
  async function ensurePlayback(player: CustomPlayer): Promise<void> {
    if (!player.playing) {
      await player.play(player.paused ? { paused: false } : undefined)
    }
  }

  return {
    getOrCreatePlayer,
    connectPlayer,
    search,
    handleTrackPlay,
    handlePlaylistPlay,
    ensurePlayback,
  }
}
