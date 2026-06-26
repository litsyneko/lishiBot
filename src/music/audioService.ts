import type { LavalinkManager, Track, UnresolvedTrack, SearchResult, UnresolvedSearchResult } from 'lavalink-client'
import type { ChatInputCommandInteraction, GuildMember } from 'discord.js'
import { PermissionFlagsBits } from 'discord.js'
import { logger } from '../utils/logger'
import { buildSearchQuery } from './musicService'
import { buildTrackAdded, buildPlaylistQueued, type PanelTrackInfo } from '../components/musicPanel'
import type { CustomPlayer } from './customPlayer'
import { createMusicSettingsService } from '../features/music/musicSettings'
import { setVolume } from './volumeStore'

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
    textChannelId?: string,
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
    interaction: ChatInputCommandInteraction,
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
      logger.error('AudioService', `음성 채널 연결 실패 (${player.guildId}): ${reason}`)
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
  ) {
    const searchQuery = buildSearchQuery(query)
    const result = await player.search(
      searchQuery.source !== undefined
        ? { query: searchQuery.query, source: searchQuery.source as never }
        : { query: searchQuery.query },
      requester,
    )

    if (result.loadType === 'error') {
      throw new Error('음악 검색 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.')
    }

    if (result.loadType === 'empty' || result.tracks.length === 0) {
      throw new Error('검색 결과가 없어요. 다른 검색어로 다시 시도해 주세요.')
    }

    return result
  }

  /**
   * Converts a lavalink Track to PanelTrackInfo for UI components.
   */
  function trackToPanelInfo(track: Track | UnresolvedTrack): PanelTrackInfo {
    return {
      title: track.info.title,
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
    track: Track | UnresolvedTrack,
  ): Promise<void> {
    await player.queue.add(track)

    const isNowPlaying =
      player.queue.current !== null && player.queue.current !== undefined

    const panel = buildTrackAdded({
      track: trackToPanelInfo(track),
      isPlaying: isNowPlaying,
    })

    await interaction.editReply({
      components: panel.components as never[],
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
    searchResult: SearchResult | UnresolvedSearchResult,
  ): Promise<void> {
    const tracks = searchResult.tracks.filter((t): t is Track | UnresolvedTrack => t !== null && t !== undefined)
    const playlist = searchResult.playlist
    const playlistName = playlist?.name ?? '플레이리스트'

    await player.queue.add(tracks)

    const firstTrack = tracks[0]
    const panel = buildPlaylistQueued({
      playlistName,
      trackCount: tracks.length,
      firstTrack: firstTrack !== undefined
        ? trackToPanelInfo(firstTrack)
        : { title: playlistName, author: '알 수 없음', durationMs: 0 },
    })

    await interaction.editReply({
      components: panel.components as never[],
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
