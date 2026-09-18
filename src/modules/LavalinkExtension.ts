import { config } from '../config'
import { registerControllerInteractionHandler } from '../music/controllerInteraction'
import type { CustomPlayer } from '../music/customPlayer'
import { createLavalinkManager } from '../music/lavalinkManager'
import { createPlayerControllerManager } from '../music/playerController'
import { getVolume } from '../music/volumeStore'
import { logger } from '../utils/logger'
import { getMusicSettings } from './MusicExtension'
import { setMusicManager } from './MusicExtension'
import { Extension, listener } from '@pikokr/command.ts'
import type { GuildTextBasedChannel, Snowflake } from 'discord.js'
import { ContainerBuilder, MessageFlags, TextDisplayBuilder } from 'discord.js'
import type {
  LavalinkManager,
  Player,
  Track,
  UnresolvedTrack,
} from 'lavalink-client'

const ACCENT_YELLOW = 0xf1c40f

class LavalinkExtensionClass extends Extension {
  private manager: LavalinkManager<CustomPlayer> | undefined

  private async resolveTextChannel(
    guildId: string,
    playerTextChannelId: string | null | undefined
  ): Promise<GuildTextBasedChannel | undefined> {
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

  private async sendNotification(
    player: Player,
    message: string
  ): Promise<void> {
    if (player.textChannelId === undefined || player.textChannelId === null)
      return
    const channel = await this.resolveTextChannel(
      player.guildId,
      player.textChannelId
    ).catch(() => undefined)
    if (channel === undefined) return
    try {
      await channel.send({
        components: [
          new ContainerBuilder()
            .setAccentColor(ACCENT_YELLOW)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(message)
            ),
        ],
        flags: MessageFlags.IsComponentsV2,
      })
    } catch (err) {
      // channel might be unwritable
    }
  }

  private controller:
    | ReturnType<typeof createPlayerControllerManager>
    | undefined

  @listener({ event: 'clientReady' })
  async ready() {
    if (this.manager !== undefined) return

    const manager = createLavalinkManager({
      clientId: config.clientId,
      clientUsername: this.client.user?.username ?? 'LisyBot',
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
        // lavalink-client payload 타입과 discord.js WebSocketShard.send 타입 불일치
        guild.shard.send(payload as never)
      },
    })
    this.manager = manager

    manager.nodeManager.on('connect', (node) => {
      logger.info('Lavalink', `노드 연결됨: ${node.id}`)
      void node.updateSession(true, 300_000).catch((err: unknown) => {
        logger.debug(
          'Lavalink',
          `세션 재개 활성화 실패 (${node.id}): ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      })
    })

    manager.nodeManager.on('disconnect', (node, reason) => {
      logger.warn(
        'Lavalink',
        `노드 연결 끊김: ${node.id} — ${
          reason !== undefined && reason !== null
            ? JSON.stringify(reason)
            : '알 수 없음'
        }`
      )
    })

    manager.nodeManager.on('reconnecting', (node) => {
      logger.warn('Lavalink', `노드 재연결 중: ${node.id}`)
    })

    manager.nodeManager.on('error', (node, error: unknown) => {
      logger.error(
        'Lavalink',
        `노드 오류 (${node.id}): ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })

    manager.nodeManager.on('destroy', (node, destroyReason?: string) => {
      logger.error(
        'Lavalink',
        `노드 파괴됨: ${node.id}${
          destroyReason !== undefined ? ` — ${destroyReason}` : ''
        }`
      )
    })

    manager.nodeManager.on('resumed', (node, _payload, players) => {
      const count = Array.isArray(players) ? players.length : 0
      logger.info(
        'Lavalink',
        `노드 세션 재개 완료: ${node.id} (${count}개 플레이어 복원)`
      )
    })

    manager.on('trackStart', (player: CustomPlayer, track) => {
      try {
        if (track === null) {
          return
        }

        const savedVolume = getVolume(player.guildId)
        if (player.volume !== savedVolume) {
          void player.setVolume(savedVolume).catch((err: unknown) => {
            logger.debug(
              'Lavalink',
              `setVolume failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        }

        if (this.controller === undefined) return

        void this.controller.onTrackStart(player).catch((err) => {
          logger.error(
            'Lavalink',
            `trackStart controller error: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        })
      } catch (err) {
        logger.error(
          'Lavalink',
          `trackStart 이벤트 처리 중 오류: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    })

    manager.on('queueEnd', async (player: CustomPlayer) => {
      try {
        await this.controller?.onQueueEnd(player)
        logger.info('Lavalink', `길드 ${player.guildId}: 대기열 종료`)
      } catch (err) {
        logger.error(
          'Lavalink',
          `queueEnd 이벤트 처리 중 오류: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    })

    manager.on('trackEnd', (player: CustomPlayer, track: Track | null) => {
      logger.info(
        'Lavalink',
        `트랙 종료: ${track?.info.title ?? '알 수 없음'} — ${
          track?.info.author ?? ''
        }`
      )
    })

    manager.on(
      'trackStuck',
      async (player: CustomPlayer, track: Track | null) => {
        logger.warn(
          'Lavalink',
          `트랙 응답 없음: ${track?.info.title ?? '알 수 없음'}`
        )
        await this.sendNotification(
          player,
          `⚠️ **${
            track?.info.title ?? '알 수 없는 곡'
          }**이 응답하지 않아 건너뛰었어요.`
        )
        if (player.queue.tracks.length > 0) {
          await player.skip().catch((err: unknown) => {
            logger.debug(
              'Lavalink',
              `skip failed: ${err instanceof Error ? err.message : String(err)}`
            )
          })
        } else {
          await player.stopPlaying().catch((err: unknown) => {
            logger.debug(
              'Lavalink',
              `stopPlaying failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        }
      }
    )

    manager.on(
      'trackError',
      async (player: CustomPlayer, track: Track | UnresolvedTrack | null) => {
        logger.error(
          'Lavalink',
          `트랙 오류: ${track?.info.title ?? '알 수 없음'}`
        )
        await this.sendNotification(
          player,
          `❌ **${
            track?.info.title ?? '알 수 없는 곡'
          }** 재생 중 오류가 발생했어요.`
        )
        if (player.queue.tracks.length > 0) {
          await player.skip().catch((err: unknown) => {
            logger.debug(
              'Lavalink',
              `skip failed: ${err instanceof Error ? err.message : String(err)}`
            )
          })
        } else {
          await player.stopPlaying().catch((err: unknown) => {
            logger.debug(
              'Lavalink',
              `stopPlaying failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        }
      }
    )

    manager.on('playerDestroy', (player: CustomPlayer) => {
      try {
        void this.controller?.onPlayerDestroy(player).catch((err: unknown) => {
          logger.debug(
            'Lavalink',
            `onPlayerDestroy failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        })
      } catch (err) {
        logger.debug(
          'Lavalink',
          `playerDestroy 처리 중 오류: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    })

    try {
      const user = this.client.user
      if (user === null) {
        logger.warn('Lavalink', 'client.user가 없어 초기화를 건너뛰어요.')
        return
      }
      await this.initWithRetry(manager, user.id, user.username)
      this.controller = createPlayerControllerManager(
        this.client,
        manager,
        (guildId, tcid) => this.resolveTextChannel(guildId, tcid)
      )
      registerControllerInteractionHandler(this.client, manager)
      setMusicManager(manager)
      logger.info('Lavalink', `Lavalink 매니저 초기화 완료 (client=${user.id})`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      logger.error('Lavalink', `Lavalink 초기화 실패: ${reason}`)
    }
  }

  private async initWithRetry(
    manager: LavalinkManager<CustomPlayer>,
    clientId: string,
    clientUsername: string,
    fastAttempts = 5,
    maxRounds = 4,
    fastBaseDelayMs = 2_000,
    slowDelayMs = 5 * 60 * 1000
  ): Promise<void> {
    const totalAttempts = fastAttempts * maxRounds

    for (let round = 1; round <= maxRounds; round += 1) {
      for (let attempt = 1; attempt <= fastAttempts; attempt += 1) {
        const globalAttempt = (round - 1) * fastAttempts + attempt
        try {
          await manager.init({ id: clientId, username: clientUsername })
          if (globalAttempt > 1) {
            logger.info(
              'Lavalink',
              `init 성공 (라운드 ${round}, 시도 ${globalAttempt}/${totalAttempts})`
            )
          }
          return
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          const delay = fastBaseDelayMs * attempt
          logger.warn(
            'Lavalink',
            `init 시도 ${globalAttempt}/${totalAttempts} (라운드 ${round}) 실패: ${reason} — ${
              delay / 1000
            }초 후 재시도`
          )
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
      if (round < maxRounds) {
        logger.warn(
          'Lavalink',
          `라운드 ${round} 전체 실패 — ${slowDelayMs / 1000}초 후 라운드 ${
            round + 1
          } 시작`
        )
        await new Promise((resolve) => setTimeout(resolve, slowDelayMs))
      }
    }

    throw new Error(`Lavalink init 포기 — ${totalAttempts}회 시도 후 연결 실패`)
  }

  @listener({ event: 'raw' })
  async raw(data: unknown) {
    try {
      if (this.manager === undefined) {
        return
      }
      // lavalink-client sendRawData 타입과 discord.js voice packet 타입 불일치
      this.manager.sendRawData(data as never)
    } catch (err) {
      logger.error(
        'Lavalink',
        `raw 이벤트 처리 중 오류: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
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
