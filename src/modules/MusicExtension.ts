import { Extension, SubCommandGroup, listener, option } from '@pikokr/command.ts'
import { ApplicationCommandOptionType, ChatInputCommandInteraction, GuildMember, MessageFlags, PermissionFlagsBits } from 'discord.js'
import type { LavalinkManager } from 'lavalink-client'
import type { CustomPlayer } from '../music/customPlayer'
import { formatQueuePage, paginateQueue, parseSeekInput, type RepeatMode } from '../music/musicService'
import { createAudioService } from '../music/audioService'
import type { AudioService } from '../music/audioService'
import { replyEphemeral } from '../utils/replies'
import { createMusicSettingsService } from '../features/music/musicSettings'
import { getVolume, setVolume } from '../music/volumeStore'
import { logger } from '../utils/logger'

const musicGroup = new SubCommandGroup({ name: '음악', description: '음악 재생 명령어' })

const musicSettings = createMusicSettingsService()

let lavalinkManager: LavalinkManager<CustomPlayer> | undefined

export function setMusicManager(manager: LavalinkManager<CustomPlayer> | undefined): void {
  lavalinkManager = manager
}

export function getMusicManager(): LavalinkManager<CustomPlayer> {
  if (lavalinkManager === undefined) {
    throw new Error('Lavalink 서버가 연결되지 않았어요. 설정을 확인해 주세요.')
  }
  return lavalinkManager
}

export function getMusicSettings() {
  return musicSettings
}

function requireManager(): LavalinkManager<CustomPlayer> {
  if (lavalinkManager === undefined) {
    throw new Error('Lavalink 서버가 연결되지 않았어요. 설정을 확인해 주세요.')
  }
  return lavalinkManager
}

function requireAudioService(): AudioService {
  return createAudioService(requireManager())
}

function requireGuild(interaction: ChatInputCommandInteraction): string {
  const guild = interaction.guild
  if (guild === null) {
    throw new Error('서버 안에서만 음악 명령을 사용할 수 있어요.')
  }
  return guild.id
}

function requireVoiceChannelId(interaction: ChatInputCommandInteraction): string {
  const member = interaction.member
  if (!(member instanceof GuildMember)) {
    throw new Error('서버 안에서만 음악 명령을 사용할 수 있어요.')
  }

  const voiceChannelId = member.voice.channelId
  if (voiceChannelId === null) {
    throw new Error('음성 채널에 먼저 들어가 주세요.')
  }

  return voiceChannelId
}

class MusicExtensionClass extends Extension {
  @musicGroup.command({ name: '재생', description: '곡을 검색하거나 URL로 재생합니다.' })
  async play(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '검색어',
      description: '곡 제목 또는 URL',
      required: true,
      autocomplete: true,
    })
    query: string,
  ) {
    try {
      const guildId = requireGuild(i)
      const voiceChannelId = requireVoiceChannelId(i)
      const textChannelId = i.channelId ?? undefined

      await i.deferReply()

      const audio = requireAudioService()

      const player = await audio.getOrCreatePlayer(guildId, voiceChannelId, textChannelId)
      const result = await audio.search(player, query, i.user)
      await audio.connectPlayer(player, i)

      if (result.loadType === 'playlist') {
        await audio.handlePlaylistPlay(i as ChatInputCommandInteraction<'cached'>, player, result)
      } else {
        const track = result.tracks[0]
        if (track === null || track === undefined) {
          await i.editReply('재생할 곡을 찾지 못했어요.')
          return
        }
        await audio.handleTrackPlay(i as ChatInputCommandInteraction<'cached'>, player, track)
      }

      await audio.ensurePlayback(player)
    } catch (err) {
      const message = err instanceof Error ? err.message : '알 수 없는 오류가 발생했어요.'
      try {
        if (i.deferred || i.replied) {
          await i.editReply(message)
        } else {
          await i.reply({ content: message, flags: MessageFlags.Ephemeral })
        }
      } catch {
        // ignore secondary failures
      }
    }
  }

  @musicGroup.command({ name: '스킵', description: '현재 곡을 건너뜁니다.' })
  async skip(i: ChatInputCommandInteraction) {
    const guildId = requireGuild(i)
    const manager = requireManager()
    const player = manager.getPlayer(guildId)

    if (player === undefined || player.queue.tracks.length === 0) {
      await replyEphemeral(i, '건너뛸 곡이 없어요.')
      return
    }

    const skipped = player.queue.current
    await player.skip()
    await replyEphemeral(
      i,
      skipped !== undefined && skipped !== null
        ? `스킵했어요: **${skipped.info.title}**`
        : '곡을 건너뛰었어요.',
    )
  }

  @musicGroup.command({ name: '정지', description: '재생을 정지하고 대기열을 비웁니다.' })
  async stop(i: ChatInputCommandInteraction) {
    const guildId = requireGuild(i)
    const manager = requireManager()
    const player = manager.getPlayer(guildId)

    if (player === undefined) {
      await replyEphemeral(i, '재생 중인 봇이 없어요.')
      return
    }

    await player.destroy()
    await replyEphemeral(i, '재생을 정지하고 대기열을 비웠어요.')
  }

  @musicGroup.command({ name: '일시정지', description: '재생을 일시정지합니다.' })
  async pause(i: ChatInputCommandInteraction) {
    const guildId = requireGuild(i)
    const manager = requireManager()
    const player = manager.getPlayer(guildId)

    if (player === undefined || !player.playing) {
      await replyEphemeral(i, '재생 중인 곡이 없어요.')
      return
    }

    await player.pause()
    await replyEphemeral(i, '일시정지했어요.')
  }

  @musicGroup.command({ name: '다시재생', description: '일시정지된 곡을 다시 재생합니다.' })
  async resume(i: ChatInputCommandInteraction) {
    const guildId = requireGuild(i)
    const manager = requireManager()
    const player = manager.getPlayer(guildId)

    if (player === undefined || !player.paused) {
      await replyEphemeral(i, '일시정지된 곡이 없어요.')
      return
    }

    await player.resume()
    await replyEphemeral(i, '다시 재생했어요.')
  }

  @musicGroup.command({ name: '대기열', description: '대기열을 확인합니다.' })
  async queue(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '페이지',
      description: '페이지 번호 (기본 1)',
      min_value: 1,
      required: false,
    })
    _page: number,
  ) {
    const guildId = requireGuild(i)
    const manager = requireManager()
    const player = manager.getPlayer(guildId)

    const pageInput = i.options.getInteger('페이지') ?? 1
    const page = Math.max(1, pageInput)

    if (player === undefined || player.queue.tracks.length === 0) {
      await replyEphemeral(i, '대기열이 비어 있어요.')
      return
    }

    const tracks = player.queue.tracks.map((track) => ({
      author: track.info.author ?? '알 수 없음',
      durationMs: track.info.duration ?? 0,
      title: track.info.title,
    }))

    const queuePage = paginateQueue(tracks, { page: page - 1, perPage: 10 })
    await replyEphemeral(i, formatQueuePage(queuePage))
  }

  @musicGroup.command({ name: '재생중', description: '지금 재생 중인 곡을 확인합니다.' })
  async nowplaying(i: ChatInputCommandInteraction) {
    const guildId = requireGuild(i)
    const manager = requireManager()
    const player = manager.getPlayer(guildId)

    const track = player?.queue.current
    if (track === undefined || track === null) {
      await replyEphemeral(i, '지금 재생 중인 곡이 없어요.')
      return
    }

    await replyEphemeral(
      i,
      `지금 재생 중: **${track.info.title}** — ${track.info.author ?? '알 수 없음'}`,
    )
  }

  @musicGroup.command({ name: '볼륨', description: '볼륨을 설정합니다 (0-100).' })
  async volume(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '볼륨',
      description: '볼륨 (0-100)',
      min_value: 0,
      max_value: 100,
      required: true,
    })
    volume: number,
  ) {
    const guildId = requireGuild(i)
    const manager = requireManager()
    const player = manager.getPlayer(guildId)

    if (player === undefined) {
      await replyEphemeral(i, '재생 중인 봇이 없어요.')
      return
    }

    await player.setVolume(volume)
    setVolume(guildId, volume)
    musicSettings.patchSettings(guildId, { volume }).catch(() => {})
    await replyEphemeral(i, `볼륨을 ${volume}으로 설정했어요. 다음 곡부터도 유지돼요.`)
  }

  @musicGroup.command({ name: '셔플', description: '대기열을 무작위로 섞습니다.' })
  async shuffle(i: ChatInputCommandInteraction) {
    const guildId = requireGuild(i)
    const manager = requireManager()
    const player = manager.getPlayer(guildId)

    if (player === undefined || player.queue.tracks.length < 2) {
      await replyEphemeral(i, '셔플할 곡이 충분하지 않아요.')
      return
    }

    player.queue.shuffle()
    await replyEphemeral(i, '대기열을 섞었어요.')
  }

  @musicGroup.command({ name: '반복', description: '반복 모드를 설정합니다.' })
  async repeat(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '모드',
      description: '반복 모드',
      choices: [
        { name: '끄기', value: 'off' },
        { name: '한 곡 반복', value: 'track' },
        { name: '대기열 반복', value: 'queue' },
      ],
      required: true,
    })
    mode: RepeatMode,
  ) {
    const guildId = requireGuild(i)
    const manager = requireManager()
    const player = manager.getPlayer(guildId)

    if (player === undefined) {
      await replyEphemeral(i, '재생 중인 봇이 없어요.')
      return
    }

    await player.setRepeatMode(mode)
    musicSettings.patchSettings(guildId, { repeatMode: mode }).catch(() => {})
    const label =
      mode === 'off' ? '반복을 끄고' : mode === 'track' ? '한 곡 반복으로' : '대기열 반복으로'
    await replyEphemeral(i, `${label} 설정했어요.`)
  }

  @musicGroup.command({ name: '탐색', description: '재생 위치를 이동합니다.' })
  async seek(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '위치',
      description: '위치 (예: 1:30 또는 90)',
      required: true,
    })
    input: string,
  ) {
    const guildId = requireGuild(i)
    const manager = requireManager()
    const player = manager.getPlayer(guildId)

    if (player === undefined || player.queue.current === undefined) {
      await replyEphemeral(i, '재생 중인 곡이 없어요.')
      return
    }

    const positionMs = parseSeekInput(input)
    await player.seek(positionMs)
    await replyEphemeral(i, `\`${input}\` 위치로 이동했어요.`)
  }

  @musicGroup.command({ name: '삭제', description: '대기열에서 특정 곡을 삭제합니다.' })
  async remove(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '번호',
      description: '대기열 번호',
      min_value: 1,
      required: true,
    })
    index: number,
  ) {
    const guildId = requireGuild(i)
    const manager = requireManager()
    const player = manager.getPlayer(guildId)

    if (player === undefined || player.queue.tracks.length < index) {
      await replyEphemeral(i, '해당 번호의 곡이 없어요.')
      return
    }

    player.queue.remove(index - 1)
    await replyEphemeral(i, `${index}번 곡을 삭제했어요.`)
  }

  @musicGroup.command({ name: '비우기', description: '대기열을 비웁니다 (현재 곡은 유지).' })
  async clear(i: ChatInputCommandInteraction) {
    const guildId = requireGuild(i)
    const manager = requireManager()
    const player = manager.getPlayer(guildId)

    if (player === undefined || player.queue.tracks.length === 0) {
      await replyEphemeral(i, '대기열이 이미 비어 있어요.')
      return
    }

    player.queue.tracks.splice(0, player.queue.tracks.length)
    await replyEphemeral(i, '대기열을 비웠어요.')
  }

  @musicGroup.command({ name: '채널설정', description: '음악 알림을 보낼 DJ 채널을 지정합니다. (관리자 전용)' })
  async setchannel(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Channel,
      name: '채널',
      description: 'DJ 채널로 지정할 텍스트 채널 (비워두면 해제)',
      required: false,
    })
    _channel: unknown,
  ) {
    const guildId = requireGuild(i)

    const member = i.member
    if (!(member instanceof GuildMember) || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await replyEphemeral(i, '서버 관리 권한이 필요해요.')
      return
    }

    const channel = i.options.getChannel('채널', false)
    const channelId = channel !== null ? channel.id : null

    musicSettings.setDjChannelId(guildId, channelId).catch(() => {})

    if (channelId === null) {
      await replyEphemeral(i, 'DJ 채널 설정을 해제했어요. 이제 명령어를 사용한 채널에 알림을 보내요.')
    } else {
      await replyEphemeral(i, `<#${channelId}>을(를) DJ 채널로 지정했어요.`)
    }
  }

  @musicGroup.command({ name: '채널', description: '현재 지정된 DJ 채널을 확인합니다.' })
  async channel(i: ChatInputCommandInteraction) {
    const guildId = requireGuild(i)
    const djChannelId = await musicSettings.getDjChannelId(guildId)

    if (djChannelId === null) {
      await replyEphemeral(i, '지정된 DJ 채널이 없어요. `/음악 채널설정`으로 지정할 수 있어요.')
    } else {
      await replyEphemeral(i, `현재 DJ 채널: <#${djChannelId}>`)
    }
  }

  @listener({ event: 'clientReady' })
  async onReady() {
    try {
      await musicSettings.ensureTableSchema()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      logger.error('MusicSettings', `스키마 마이그레이션 실패: ${reason}`)
    }
  }

  @listener({ event: 'clientReady' })
  async registerAutocomplete() {
    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isAutocomplete()) {
        return
      }
      if (interaction.commandName !== '음악') {
        return
      }
      if (interaction.options.getSubcommand() !== '재생') {
        return
      }

      const query = interaction.options.getFocused().toString().trim()

      if (query.length === 0) {
        await interaction.respond([{ name: '🔎 검색어를 입력해 주세요', value: '' }])
        return
      }

      if (query.length < 2) {
        await interaction.respond([
          { name: '인기 음악', value: '인기 음악' },
          { name: '최신 K-POP', value: '최신 K-POP' },
          { name: '팝송 모음', value: '팝송 모음' },
          { name: '발라드 명곡', value: '발라드 명곡' },
          { name: '힙합 음악', value: '힙합 음악' },
          { name: '재즈 음악', value: '재즈 음악' },
          { name: '클래식 음악', value: '클래식 음악' },
          { name: 'R&B 추천', value: 'R&B 추천' },
        ])
        return
      }

      try {
        const suggestions = await fetchYouTubeSuggestions(query, 10)
        if (suggestions.length === 0) {
          await interaction.respond([
            { name: query.slice(0, 100), value: query.slice(0, 100) },
          ])
          return
        }
        const choices = suggestions.map((s) => ({
          name: s.length > 100 ? s.slice(0, 97) + '...' : s,
          value: s.length > 100 ? s.slice(0, 100) : s,
        }))
        await interaction.respond(choices)
      } catch {
        await interaction.respond([
          { name: query.slice(0, 100), value: query.slice(0, 100) },
          { name: `${query} 음악`.slice(0, 100), value: `${query} 음악`.slice(0, 100) },
          { name: `${query} 노래`.slice(0, 100), value: `${query} 노래`.slice(0, 100) },
        ])
      }
    })
  }
}

async function fetchYouTubeSuggestions(query: string, maxResults: number): Promise<string[]> {
  const params = new URLSearchParams({
    ds: 'yt',
    hl: 'ko',
    gl: 'kr',
    client: 'youtube',
    gs_ri: 'youtube',
    q: query,
  })
  const res = await fetch(`https://suggestqueries-clients6.youtube.com/complete/search?${params}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/javascript, application/javascript, application/ecmascript, */*; q=0.01',
      Referer: 'https://www.youtube.com/',
    },
  })
  if (!res.ok) {
    return []
  }
  const text = await res.text()
  const match = text.match(/window\.google\.ac\.h\((\[.*\])\)/)
  if (!match) {
    return []
  }
  const data = JSON.parse(match[1]) as [string, Array<[string, number]>]
  return data[1].slice(0, maxResults).map((item) => item[0])
}

export const setup = async () => {
  return new MusicExtensionClass()
}
