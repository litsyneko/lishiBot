import { logger } from '../utils/logger'
import {
  type AudioPlayer,
  AudioPlayerStatus,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice'
import type { Guild } from 'discord.js'
import { Readable } from 'stream'

type GuildVoice = {
  readonly connection: VoiceConnection
  readonly player: AudioPlayer
  readonly queue: Buffer[]
  playing: boolean
  voiceChannelId: string
  // 큐가 전부 재생되면 1회 실행(만료 종료 절차: 저장된 음성 재생 후 퇴장).
  leaveWhenDrained?: () => void
}

const guildVoices = new Map<string, GuildVoice>()

// 재연결 실패로 음성에서 강제로 떨어졌을 때(관리자가 연결 끊기 등) 알림용 훅.
// 의도된 퇴장(/tts 퇴장, 빈 채널 자동 퇴장)에는 호출되지 않는다.
type ForcedDisconnectHandler = (guildId: string) => void
let forcedDisconnectHandler: ForcedDisconnectHandler | undefined

export function setForcedDisconnectHandler(
  handler: ForcedDisconnectHandler
): void {
  forcedDisconnectHandler = handler
}

export function isConnected(guildId: string): boolean {
  return guildVoices.has(guildId)
}

export function getVoiceChannelId(guildId: string): string | undefined {
  return guildVoices.get(guildId)?.voiceChannelId
}

export async function joinGuildVoice(
  guild: Guild,
  voiceChannelId: string
): Promise<void> {
  const existing = guildVoices.get(guild.id)
  if (existing !== undefined) {
    if (existing.voiceChannelId === voiceChannelId) return
    // 다른 채널로 이동
    existing.connection.destroy()
    guildVoices.delete(guild.id)
  }

  const connection = joinVoiceChannel({
    adapterCreator: guild.voiceAdapterCreator,
    channelId: voiceChannelId,
    guildId: guild.id,
    selfDeaf: true,
    selfMute: false,
  })

  const player = createAudioPlayer()
  connection.subscribe(player)

  const guildVoice: GuildVoice = {
    connection,
    player,
    playing: false,
    queue: [],
    voiceChannelId,
  }
  guildVoices.set(guild.id, guildVoice)

  player.on(AudioPlayerStatus.Idle, () => {
    playNext(guild.id)
  })
  player.on('error', (err) => {
    logger.warn('TTS', `오디오 재생 오류: ${err.message}`)
    playNext(guild.id)
  })

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ])
    } catch {
      leaveGuildVoice(guild.id)
      forcedDisconnectHandler?.(guild.id)
    }
  })

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000)
  } catch {
    logger.warn('TTS', `음성 연결 준비 실패 (guild ${guild.id})`)
    leaveGuildVoice(guild.id)
    throw new Error('음성 연결에 실패했어요.')
  }
}

export function enqueueAudio(guildId: string, audio: Buffer): void {
  const guildVoice = guildVoices.get(guildId)
  if (guildVoice === undefined) return

  guildVoice.queue.push(audio)
  if (!guildVoice.playing) playNext(guildId)
}

// 이미 큐에 쌓인(합성 완료·저장된) 음성이 전부 재생된 뒤 onDrained를 1회 실행.
// 지금 재생 중도 아니고 큐도 비었으면 즉시 실행한다.
export function scheduleLeaveWhenDrained(
  guildId: string,
  onDrained: () => void
): void {
  const guildVoice = guildVoices.get(guildId)
  if (guildVoice === undefined) {
    onDrained()
    return
  }

  guildVoice.leaveWhenDrained = onDrained
  if (!guildVoice.playing && guildVoice.queue.length === 0) {
    guildVoice.leaveWhenDrained = undefined
    onDrained()
  }
}

function playNext(guildId: string): void {
  const guildVoice = guildVoices.get(guildId)
  if (guildVoice === undefined) return

  const next = guildVoice.queue.shift()
  if (next === undefined) {
    guildVoice.playing = false
    // 저장된 음성이 전부 재생됨 → 예약된 종료 절차 실행
    const onDrained = guildVoice.leaveWhenDrained
    if (onDrained !== undefined) {
      guildVoice.leaveWhenDrained = undefined
      onDrained()
    }
    return
  }

  guildVoice.playing = true
  const resource = createAudioResource(Readable.from(next), {
    inputType: StreamType.Arbitrary,
  })
  guildVoice.player.play(resource)
}

export function leaveGuildVoice(guildId: string): void {
  const guildVoice = guildVoices.get(guildId)
  if (guildVoice === undefined) return

  guildVoice.queue.length = 0
  try {
    guildVoice.player.stop(true)
    guildVoice.connection.destroy()
  } catch {
    // 이미 파괴됨
  }
  guildVoices.delete(guildId)
}
