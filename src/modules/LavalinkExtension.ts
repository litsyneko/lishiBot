import { Extension, listener } from '@pikokr/command.ts'
import type { LavalinkManager, Player, Track, UnresolvedTrack } from 'lavalink-client'
import type { GuildTextBasedChannel, Snowflake } from 'discord.js'
import type { CustomPlayer } from '../music/customPlayer'
import { ContainerBuilder, TextDisplayBuilder, MessageFlags } from 'discord.js'
import { config } from '../config'
import { createLavalinkManager } from '../music/lavalinkManager'
import { createPlayerControllerManager } from '../music/playerController'
import { registerControllerInteractionHandler } from '../music/controllerInteraction'
import { getVolume } from '../music/volumeStore'
import { getMusicSettings } from './MusicExtension'
import { setMusicManager } from './MusicExtension'
import { logger } from '../utils/logger'

const ACCENT_RED = 0xe74c3b
const ACCENT_YELLOW = 0xf1c40f

class LavalinkExtensionClass extends Extension {
  private manager: LavalinkManager<CustomPlayer> | undefined

  private async resolveTextChannel(guildId: string, playerTextChannelId: string | null | undefined): Promise<GuildTextBasedChannel | undefined> {
    const guild = this.client.guilds.cache.get(guildId)
    if (guild === undefined) {
      return undefined
    }

    const djChannelId = await getMusicSettings().getDjChannelId(guildId)
    const candidates: (string | undefined)[] = [
      djChannelId ?? undefined,
      playerTextChannelId ?? undefined,
      guild.systemChannelId ?? undefined,
    ]

    for (const id of candidates) {
      if (id === undefined || id.length === 0) {
        continue
      }
      const ch = guild.channels.cache.get(id as Snowflake)
      if (ch !== undefined && ch.isTextBased() && 'send' in ch) {
        return ch as GuildTextBasedChannel
      }
    }
    return undefined
  }

  private async sendNotification(player: Player, message: string): Promise<void> {
    if (player.textChannelId === undefined || player.textChannelId === null) return
    const channel = await this.resolveTextChannel(player.guildId, player.textChannelId).catch(() => undefined)
    if (channel === undefined) return
    try {
      await channel.send({
        components: [
          new ContainerBuilder()
            .setAccentColor(ACCENT_YELLOW)
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(message)),
        ],
        flags: MessageFlags.IsComponentsV2,
      })
    } catch {
      // channel might be unwritable
    }
  }

  private controller: ReturnType<typeof createPlayerControllerManager> | undefined

  @listener({ event: 'clientReady' })
  async ready() {
    const manager = createLavalinkManager({
      clientId: config.clientId,
      clientUsername: this.client.user?.username ?? 'FullMoonBot',
      host: config.lavalink.host,
      password: config.lavalink.password,
      port: config.lavalink.port,
      secure: config.lavalink.secure,
      sendToShard: (guildId, payload) => {
        const guild = this.client.guilds.cache.get(guildId)
        if (guild === undefined) {
          return
        }
        if (guild.shard === undefined || guild.shard === null) {
          return
        }
        guild.shard.send(payload as never)
      },
    })
    this.manager = manager

    manager.on('trackStart', (player: CustomPlayer, track) => {
      try {
        if (track === null) {
          return
        }

        const savedVolume = getVolume(player.guildId)
        if (player.volume !== savedVolume) {
          void player.setVolume(savedVolume).catch(() => {})
        }

        if (this.controller === undefined) return

        void this.controller.onTrackStart(player).catch((err) => {
          logger.error('Lavalink', `trackStart controller error: ${err instanceof Error ? err.message : String(err)}`)
        })
      } catch (err) {
        logger.error('Lavalink', `trackStart 이벤트 처리 중 오류: ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    manager.on('queueEnd', async (player: CustomPlayer) => {
      try {
        await this.controller?.onQueueEnd(player)
        logger.info('Lavalink', `길드 ${player.guildId}: 대기열 종료`)
      } catch (err) {
        logger.error('Lavalink', `queueEnd 이벤트 처리 중 오류: ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    manager.on('trackEnd', (player: CustomPlayer, track: Track | null) => {
      logger.info('Lavalink', `트랙 종료: ${track?.info.title ?? '알 수 없음'} — ${track?.info.author ?? ''}`)
    })

    manager.on('trackStuck', async (player: CustomPlayer, track: Track | null) => {
      logger.warn('Lavalink', `트랙 응답 없음: ${track?.info.title ?? '알 수 없음'}`)
      await this.sendNotification(player, `⚠️ **${track?.info.title ?? '알 수 없는 곡'}**이 응답하지 않아 건너뛰었어요.`)
      if (player.queue.tracks.length > 0) {
        await player.skip().catch(() => {})
      } else {
        await player.stopPlaying().catch(() => {})
      }
    })

    manager.on('trackError', async (player: CustomPlayer, track: Track | UnresolvedTrack | null) => {
      logger.error('Lavalink', `트랙 오류: ${track?.info.title ?? '알 수 없음'}`)
      await this.sendNotification(player, `❌ **${track?.info.title ?? '알 수 없는 곡'}** 재생 중 오류가 발생했어요.`)
      if (player.queue.tracks.length > 0) {
        await player.skip().catch(() => {})
      } else {
        await player.stopPlaying().catch(() => {})
      }
    })

    manager.on('playerDestroy', (player: CustomPlayer) => {
      try {
        void this.controller?.onPlayerDestroy(player).catch(() => {})
      } catch {
        // ignore
      }
    })

    try {
      await manager.init({ id: this.client.user!.id, username: this.client.user!.username })
      this.controller = createPlayerControllerManager(
        this.client,
        manager,
        (guildId, tcid) => this.resolveTextChannel(guildId, tcid),
      )
      registerControllerInteractionHandler(this.client, manager)
      setMusicManager(manager)
      logger.info('Lavalink', `Lavalink 매니저 초기화 완료 (client=${this.client.user!.id})`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      logger.error('Lavalink', `Lavalink 초기화 실패: ${reason}`)
    }
  }

  @listener({ event: 'raw' })
  async raw(data: unknown) {
    try {
      if (this.manager === undefined) {
        return
      }
      this.manager.sendRawData(data as never)
    } catch (err) {
      logger.error('Lavalink', `raw 이벤트 처리 중 오류: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  @listener({ event: 'applicationCommandInvokeError', emitter: 'cts' })
  async errorHandler(err: Error) {
    logger.error('Command', `명령 실행 중 오류: ${err.message}`)
  }
}

export const setup = async () => {
  return new LavalinkExtensionClass()
}
