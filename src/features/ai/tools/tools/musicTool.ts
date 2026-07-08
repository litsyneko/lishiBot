import { createMusicSettingsService } from '../../../../features/music/musicSettings'
import { getMusicManager } from '../../../../modules/MusicExtension'
import type { CustomPlayer } from '../../../../music/customPlayer'
import { buildSearchQuery } from '../../../../music/musicService'
import { getVolume, setVolume } from '../../../../music/volumeStore'
import { logger } from '../../../../utils/logger'
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../toolTypes'
import type { Client, GuildMember } from 'discord.js'
import { PermissionFlagsBits } from 'discord.js'
import type { SearchPlatform, Track, UnresolvedTrack } from 'lavalink-client'

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

async function resolveMember(
  client: Client,
  guildId: string,
  userId: string
): Promise<
  | { guild: GuildMember['guild']; member: GuildMember }
  | { success: false; message: string }
> {
  const guild = client.guilds.cache.get(guildId)
  if (guild === undefined) {
    return { success: false, message: '서버 정보를 찾을 수 없어요.' }
  }

  const member = await guild.members.fetch(userId).catch(() => undefined)
  if (member === undefined) {
    return { success: false, message: '멤버 정보를 찾을 수 없어요.' }
  }

  return { guild, member }
}

function checkVoiceChannel(
  member: GuildMember
): { voiceChannelId: string } | { success: false; message: string } {
  const voiceChannel = member.voice.channel
  if (voiceChannel === null || voiceChannel === undefined) {
    return { success: false, message: '먼저 음성 채널에 입장해 주세요.' }
  }

  return { voiceChannelId: voiceChannel.id }
}

function checkBotVoicePermissions(member: GuildMember): ToolResult | undefined {
  const me = member.guild.members.me
  if (me === null) return undefined

  const voiceChannel = member.voice.channel
  if (voiceChannel === null || voiceChannel === undefined) return undefined

  const perms = voiceChannel.permissionsFor(me)
  if (perms === null) return undefined

  if (!perms.has(PermissionFlagsBits.Connect)) {
    return { success: false, message: '봇이 음성 채널에 접속할 권한이 없어요.' }
  }
  if (!perms.has(PermissionFlagsBits.Speak)) {
    return { success: false, message: '봇이 음성 채널에서 말할 권한이 없어요.' }
  }

  return undefined
}

async function getOrCreatePlayerWithSettings(
  guildId: string,
  voiceChannelId: string,
  textChannelId: string
): Promise<CustomPlayer> {
  const manager = getMusicManager()
  const musicSettings = createMusicSettingsService()

  let player = manager.getPlayer(guildId)
  if (player === undefined) {
    player = await manager.createPlayer({
      guildId,
      voiceChannelId,
      textChannelId,
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
  }

  return player
}

export function playMusicTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'play_music',
      description:
        '유튜브/유튜브 뮤직에서 음악이나 플레이리스트를 검색하고 재생합니다. 검색어 또는 URL을 입력하세요.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '검색어 (노래 제목, 가수) 또는 유튜브/유튜브 뮤직 URL',
          },
        },
        required: ['query'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const query = ((args.query as string) ?? '').trim()
        if (query.length === 0) {
          return { success: false, message: '검색어를 입력해 주세요.' }
        }

        const resolved = await resolveMember(
          client,
          context.guildId,
          context.userId
        )
        if ('success' in resolved) return resolved

        const voice = checkVoiceChannel(resolved.member)
        if ('success' in voice) return voice

        const permError = checkBotVoicePermissions(resolved.member)
        if (permError !== undefined) return permError

        const player = await getOrCreatePlayerWithSettings(
          context.guildId,
          voice.voiceChannelId,
          context.channelId
        )

        if (!player.connected) {
          await player.connect()
        }

        const savedVolume = getVolume(context.guildId)
        if (player.volume !== savedVolume) {
          await player.setVolume(savedVolume).catch((err: unknown) => {
            logger.debug(
              'AI',
              `setVolume failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        }

        const searchQuery = buildSearchQuery(query)
        const result = await player.search(
          searchQuery.source !== undefined
            ? {
                query: searchQuery.query,
                source: searchQuery.source as SearchPlatform,
              }
            : { query: searchQuery.query },
          context.userId
        )

        if (result.loadType === 'error') {
          return { success: false, message: '음악 검색 중 오류가 발생했어요.' }
        }

        if (result.loadType === 'empty' || result.tracks.length === 0) {
          return { success: false, message: '검색 결과가 없어요.' }
        }

        const tracks = result.tracks.filter(
          (
            t: Track | UnresolvedTrack | null | undefined
          ): t is Track | UnresolvedTrack => t !== null && t !== undefined
        )

        if (result.loadType === 'playlist') {
          await player.queue.add(tracks)

          if (!player.playing) {
            await player.play()
          }

          const firstTrack = tracks[0]
          const playlistName = result.playlist?.name ?? '플레이리스트'

          if (firstTrack !== undefined) {
            const summary = `"${playlistName}" 플레이리스트 (${tracks.length}곡)을 재생 목록에 추가했어요. 첫 곡: ${firstTrack.info.title}`
            logger.info('AITool', `play_music: ${summary}`)
            return { success: true, message: summary, summary }
          }

          const summary = `"${playlistName}" 플레이리스트 ${tracks.length}곡을 재생 목록에 추가했어요.`
          logger.info('AITool', `play_music: ${summary}`)
          return { success: true, message: summary, summary }
        }

        const track = tracks[0]
        await player.queue.add(track)

        if (!player.playing) {
          await player.play()
        }

        const durationLabel =
          track.info.duration !== undefined && track.info.duration > 0
            ? ` (${formatDuration(track.info.duration)})`
            : ''
        const summary = `**${track.info.title}**${durationLabel} - ${
          track.info.author ?? '알 수 없음'
        }`
        logger.info('AITool', `play_music: ${summary}`)
        return {
          success: true,
          message: `${summary}을(를) 재생할게요!`,
          summary,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('AITool', `play_music 오류: ${message}`)
        return {
          success: false,
          message: `음악 재생 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

export function stopMusicTool(_client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'stop_music',
      description: '음악 재생을 완전히 정지하고 대기열을 비웁니다.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      _args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const manager = getMusicManager()
        const player = manager.getPlayer(context.guildId)
        if (player === undefined) {
          return { success: false, message: '재생 중인 봇이 없어요.' }
        }

        await player.destroy()
        return {
          success: true,
          message: '음악 재생을 정지하고 대기열을 비웠어요.',
          summary: '음악 재생을 정지하고 대기열을 비웠어요.',
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('AITool', `stop_music 오류: ${message}`)
        return {
          success: false,
          message: `음악 정지 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

export function pauseMusicTool(_client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'pause_music',
      description: '현재 재생 중인 음악을 일시정지합니다.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      _args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const manager = getMusicManager()
        const player = manager.getPlayer(context.guildId)
        if (player === undefined) {
          return { success: false, message: '재생 중인 봇이 없어요.' }
        }

        if (!player.playing) {
          return { success: false, message: '지금 재생 중인 곡이 없어요.' }
        }

        await player.pause()
        return {
          success: true,
          message: '일시정지했어요.',
          summary: '일시정지했어요.',
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('AITool', `pause_music 오류: ${message}`)
        return {
          success: false,
          message: `일시정지 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

export function resumeMusicTool(_client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'resume_music',
      description: '일시정지된 음악을 다시 재생합니다.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      _args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const manager = getMusicManager()
        const player = manager.getPlayer(context.guildId)
        if (player === undefined) {
          return { success: false, message: '재생 중인 봇이 없어요.' }
        }

        if (!player.paused) {
          return { success: false, message: '일시정지된 곡이 없어요.' }
        }

        await player.resume()
        return {
          success: true,
          message: '다시 재생했어요.',
          summary: '다시 재생했어요.',
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('AITool', `resume_music 오류: ${message}`)
        return {
          success: false,
          message: `다시 재생 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

export function setVolumeTool(_client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'set_volume',
      description: '음악 재생 볼륨을 0~100 사이로 설정합니다.',
      parameters: {
        type: 'object',
        properties: {
          volume: {
            type: 'integer',
            description: '설정할 볼륨 (0~100)',
          },
        },
        required: ['volume'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const volume = Number(args.volume)
        if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
          return {
            success: false,
            message: '볼륨은 0~100 사이의 정수로 입력해 주세요.',
          }
        }

        const manager = getMusicManager()
        const player = manager.getPlayer(context.guildId)
        if (player === undefined) {
          return { success: false, message: '재생 중인 봇이 없어요.' }
        }

        await player.setVolume(volume)
        setVolume(context.guildId, volume)
        createMusicSettingsService()
          .patchSettings(context.guildId, { volume })
          .catch((err: unknown) => {
            logger.debug(
              'AI',
              `patchSettings(volume) failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })

        return {
          success: true,
          message: `볼륨을 ${volume}으로 설정했어요.`,
          summary: `볼륨을 ${volume}으로 설정했어요.`,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('AITool', `set_volume 오류: ${message}`)
        return {
          success: false,
          message: `볼륨 설정 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

export function shuffleQueueTool(_client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'shuffle_queue',
      description: '음악 대기열을 무작위로 섞습니다.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      _args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const manager = getMusicManager()
        const player = manager.getPlayer(context.guildId)
        if (player === undefined) {
          return { success: false, message: '재생 중인 봇이 없어요.' }
        }

        if (player.queue.tracks.length < 2) {
          return { success: false, message: '셔플할 곡이 충분하지 않아요.' }
        }

        player.queue.shuffle()
        return {
          success: true,
          message: '대기열을 섞었어요.',
          summary: '대기열을 섞었어요.',
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('AITool', `shuffle_queue 오류: ${message}`)
        return {
          success: false,
          message: `대기열 셔플 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

export function getMusicStateTool(_client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'get_music_state',
      description:
        '현재 음악 재생 상태를 확인합니다. 현재 재생 중인 곡, 진행 시간, 볼륨, 반복 모드, 대기열 정보를 반환해요.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'info',
    },
    async execute(
      _args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const manager = getMusicManager()
        const player = manager.getPlayer(context.guildId) as
          | CustomPlayer
          | undefined

        if (player === undefined) {
          return {
            success: true,
            message: '현재 재생 중인 음악이 없어요.',
            summary: '재생 중인 음악 없음',
            data: {
              isPlaying: false,
              isPaused: false,
              isConnected: false,
              currentTrack: null,
              queue: { total: 0, tracks: [] },
              volume: 100,
              repeatMode: 'off',
            },
          }
        }

        const current = player.queue.current
        const positionMs = player.position
        const tracks = player.queue.tracks

        const currentTrackData =
          current !== null
            ? {
                title: current.info.title,
                author: current.info.author,
                durationMs: current.info.duration,
                positionMs,
                progress: `${formatDuration(positionMs)} / ${formatDuration(
                  current.info.duration
                )}`,
                uri: current.info.uri,
                artworkUrl: current.info.artworkUrl,
                sourceName: current.info.sourceName,
                isStream: current.info.isStream,
                requesterId:
                  (current.requester as { id?: string })?.id ?? undefined,
              }
            : null

        const queueList = tracks.slice(0, 10).map((t) => ({
          title: t.info.title,
          author: t.info.author,
          durationMs: t.info.duration,
          uri: t.info.uri,
        }))

        const totalQueueDuration = tracks.reduce(
          (sum, t) => sum + (t.info.duration ?? 0),
          0
        )

        let message: string
        if (current !== null) {
          const lines: string[] = []
          lines.push(`🎵 현재 재생 중: ${current.info.title}`)
          lines.push(`👤 아티스트: ${current.info.author}`)
          lines.push(
            `⏱️ 진행: ${formatDuration(positionMs)} / ${formatDuration(
              current.info.duration
            )}`
          )
          if (current.info.uri) lines.push(`🔗 링크: ${current.info.uri}`)
          lines.push(`🔁 반복: ${player.repeatMode ?? 'off'}`)
          lines.push(`🔊 볼륨: ${player.volume}`)
          lines.push(player.paused ? '⏸️ 일시정지됨' : '▶️ 재생 중')
          lines.push(
            `📋 대기열: ${tracks.length}곡 남음 (총 ${formatDuration(
              totalQueueDuration
            )})`
          )
          message = lines.join('\n')
        } else {
          message = '현재 재생 중인 음악이 없어요.'
        }
        const summary =
          current !== null
            ? `재생 중: ${current.info.title} - ${
                current.info.author
              } (${formatDuration(positionMs)}/${formatDuration(
                current.info.duration
              )}) | 볼륨: ${player.volume} | 반복: ${
                player.repeatMode ?? 'off'
              } | 대기열: ${tracks.length}곡`
            : '재생 중인 음악 없음'

        return {
          success: true,
          message,
          summary,
          data: {
            isPlaying: player.playing,
            isPaused: player.paused,
            isConnected: player.connected ?? false,
            voiceChannelId: player.voiceChannelId,
            volume: player.volume,
            repeatMode: player.repeatMode ?? 'off',
            currentTrack: currentTrackData,
            queue: {
              total: tracks.length,
              totalDurationMs: totalQueueDuration,
              tracks: queueList,
            },
            historyCount: player.queue.previous.length,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('AITool', `get_music_state 오류: ${message}`)
        return {
          success: false,
          message: `음악 상태 확인 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

export function searchMusicTool(_client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'search_music',
      description:
        '유튜브/유튜브 뮤직에서 음악을 검색하고 상위 결과를 반환합니다. 재생은 하지 않습니다.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '검색어 (노래 제목, 가수)',
          },
          limit: {
            type: 'integer',
            description: '반환할 결과 개수 (기본값: 5, 최대: 10)',
          },
        },
        required: ['query'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'info',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const query = ((args.query as string) ?? '').trim()
        if (query.length === 0) {
          return { success: false, message: '검색어를 입력해 주세요.' }
        }

        const limitInput = Number(args.limit ?? 5)
        const limit =
          Number.isInteger(limitInput) && limitInput >= 1 && limitInput <= 10
            ? limitInput
            : 5

        // Search is read-only: do NOT require voice channel membership and do NOT create a player.
        // LavalinkManager itself exposes no search method; use a Lavalink node directly via nodeManager.
        const manager = getMusicManager()
        const node = manager.nodeManager.leastUsedNodes()[0]
        if (node === undefined) {
          return {
            success: false,
            message:
              '음악 서버가 아직 연결되지 않았거나 일시적으로 사용할 수 없습니다. 관리자에게 Lavalink 상태 확인을 요청해 주세요.',
          }
        }

        const searchQuery = buildSearchQuery(query)
        const result = await node.search(
          searchQuery.source !== undefined
            ? {
                query: searchQuery.query,
                source: searchQuery.source as SearchPlatform,
              }
            : { query: searchQuery.query },
          context.userId
        )

        if (result.loadType === 'error') {
          return { success: false, message: '음악 검색 중 오류가 발생했어요.' }
        }

        if (result.loadType === 'empty' || result.tracks.length === 0) {
          return { success: false, message: '검색 결과가 없어요.' }
        }

        const tracks = result.tracks
          .filter((t): t is Track => t !== null && t !== undefined)
          .slice(0, limit)

        const list = tracks
          .map((t, i) => {
            const dur =
              t.info.duration !== undefined && t.info.duration > 0
                ? ` (${formatDuration(t.info.duration)})`
                : ''
            return `${i + 1}. ${t.info.title} - ${
              t.info.author ?? '알 수 없음'
            }${dur}`
          })
          .join('\n')

        const summary = `검색 결과:\n${list}`
        logger.info(
          'AITool',
          `search_music: ${query} → ${tracks.length}개 결과`
        )
        return {
          success: true,
          message: summary,
          summary,
          data: {
            tracks: tracks.map((t) => ({
              title: t.info.title,
              author: t.info.author ?? '알 수 없음',
              durationMs: t.info.duration ?? 0,
              uri: t.info.uri,
            })),
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('AITool', `search_music 오류: ${message}`)
        return {
          success: false,
          message: `음악 검색 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

export function seekMusicTool(_client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'seek_music',
      description:
        '현재 재생 중인 곡의 특정 위치(초)로 이동합니다. 예: 120초면 2분 위치로 이동해요.',
      parameters: {
        type: 'object',
        properties: {
          position_seconds: {
            type: 'integer',
            description:
              '이동할 위치 (초 단위). 예: 30 = 30초, 120 = 2분, 0 = 처음',
          },
        },
        required: ['position_seconds'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const positionSeconds = Number(args.position_seconds)
        if (!Number.isInteger(positionSeconds) || positionSeconds < 0) {
          return {
            success: false,
            message: '이동할 위치는 0 이상의 정수(초)로 입력해 주세요.',
          }
        }

        const manager = getMusicManager()
        const player = manager.getPlayer(context.guildId)
        if (player === undefined) {
          return { success: false, message: '재생 중인 봇이 없어요.' }
        }

        if (player.queue.current === null || !player.playing) {
          return { success: false, message: '현재 재생 중인 곡이 없어요.' }
        }

        if (player.queue.current.info.isStream) {
          return {
            success: false,
            message: '라이브 스트리밍은 탐색할 수 없어요.',
          }
        }

        const durationMs = player.queue.current.info.duration
        const positionMs = positionSeconds * 1000

        if (positionMs > durationMs) {
          return {
            success: false,
            message: `곡 길이(${formatDuration(
              durationMs
            )})를 초과할 수 없어요.`,
          }
        }

        await player.seek(positionMs)

        const summary = `${player.queue.current.info.title} - ${formatDuration(
          positionMs
        )} / ${formatDuration(durationMs)} 위치로 이동했어요.`
        logger.info('AITool', `seek_music: ${summary}`)
        return { success: true, message: summary, summary }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('AITool', `seek_music 오류: ${message}`)
        return {
          success: false,
          message: `곡 탐색 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

export function skipTrackTool(_client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'skip_track',
      description:
        '현재 재생 중인 곡을 건너뛰고 다음 곡을 재생합니다. 특정 위치의 곡으로 건너뛸 수도 있어요.',
      parameters: {
        type: 'object',
        properties: {
          to_position: {
            type: 'integer',
            description: '건너뛸 대기열 위치 (1부터 시작, 기본값: 다음 곡)',
          },
        },
        required: [],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const manager = getMusicManager()
        const player = manager.getPlayer(context.guildId)
        if (player === undefined) {
          return { success: false, message: '재생 중인 봇이 없어요.' }
        }

        if (player.queue.current === null) {
          return { success: false, message: '현재 재생 중인 곡이 없어요.' }
        }

        const toPosition =
          args.to_position !== undefined ? Number(args.to_position) : undefined

        if (toPosition !== undefined) {
          if (!Number.isInteger(toPosition) || toPosition < 1) {
            return {
              success: false,
              message: '위치는 1 이상의 정수로 입력해 주세요.',
            }
          }
          if (toPosition > player.queue.tracks.length) {
            return {
              success: false,
              message: `대기열에는 ${player.queue.tracks.length}곡만 있어요.`,
            }
          }
          await player.skip(toPosition)
          const summary = `${toPosition}번째 곡으로 건너뛰었어요.`
          logger.info('AITool', `skip_track: ${summary}`)
          return { success: true, message: summary, summary }
        }

        if (player.queue.tracks.length === 0) {
          return { success: false, message: '다음 곡이 없어요.' }
        }

        await player.skip()
        const currentTitle = player.queue.current?.info.title ?? '알 수 없음'
        const summary = `⏭️ ${currentTitle} - 다음 곡으로 건너뛰었어요.`
        logger.info('AITool', `skip_track: ${summary}`)
        return { success: true, message: summary, summary }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('AITool', `skip_track 오류: ${message}`)
        return {
          success: false,
          message: `곡 건너뛰기 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

export function removeFromQueueTool(_client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'remove_from_queue',
      description: '대기열에서 특정 순서의 곡을 제거합니다.',
      parameters: {
        type: 'object',
        properties: {
          position: {
            type: 'integer',
            description: '제거할 곡의 대기열 번호 (1부터 시작)',
          },
        },
        required: ['position'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const position = Number(args.position)
        if (!Number.isInteger(position) || position < 1) {
          return {
            success: false,
            message: '위치는 1 이상의 정수로 입력해 주세요.',
          }
        }

        const manager = getMusicManager()
        const player = manager.getPlayer(context.guildId)
        if (player === undefined) {
          return { success: false, message: '재생 중인 봇이 없어요.' }
        }

        const idx = position - 1 // 0-based
        if (idx >= player.queue.tracks.length) {
          return {
            success: false,
            message: `대기열에는 ${player.queue.tracks.length}곡만 있어요.`,
          }
        }

        const removedTrack = player.queue.tracks[idx]
        const title = removedTrack?.info.title ?? '알 수 없음'
        await player.queue.remove(idx)

        const summary = `${position}번 곡 "${title}"을(를) 대기열에서 제거했어요.`
        logger.info('AITool', `remove_from_queue: ${summary}`)
        return { success: true, message: summary, summary }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('AITool', `remove_from_queue 오류: ${message}`)
        return {
          success: false,
          message: `곡 제거 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

export function clearQueueTool(_client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'clear_queue',
      description:
        '음악 대기열의 모든 곡을 제거합니다. 현재 재생 중인 곡은 계속 재생돼요.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      _args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const manager = getMusicManager()
        const player = manager.getPlayer(context.guildId)
        if (player === undefined) {
          return { success: false, message: '재생 중인 봇이 없어요.' }
        }

        if (player.queue.tracks.length === 0) {
          return { success: false, message: '대기열이 이미 비어 있어요.' }
        }

        player.queue.splice(0, player.queue.tracks.length)

        const summary =
          '대기열의 모든 곡을 제거했어요. 현재 곡은 계속 재생됩니다.'
        logger.info('AITool', `clear_queue: ${summary}`)
        return { success: true, message: summary, summary }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('AITool', `clear_queue 오류: ${message}`)
        return {
          success: false,
          message: `대기열 초기화 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
