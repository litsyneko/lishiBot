import { config } from '../config'
import { logger } from '../utils/logger'
import type { CustomPlayer } from './customPlayer'
import { createLavalinkManager } from './lavalinkManager'
import { Client, GatewayIntentBits } from 'discord.js'
import type { LavalinkManager } from 'lavalink-client'

export type PlaybackBotStatus = 'idle' | 'playing' | 'offline' | 'busy'

export type PlaybackBot = {
  readonly id: string
  readonly label: string
  readonly client: Client
  readonly manager: LavalinkManager<CustomPlayer>
  getStatus: () => PlaybackBotStatus
}

export type PlaybackBotRegistry = {
  readonly bots: readonly PlaybackBot[]
  readonly getBot: (botId: string) => PlaybackBot | undefined
  readonly getMainBot: () => PlaybackBot | undefined
  readonly getIdleBot: (preferredBotId?: string) => PlaybackBot | undefined
  readonly getBotByVoiceChannel: (
    guildId: string,
    voiceChannelId: string
  ) => PlaybackBot | undefined
}

export function createPlaybackBotRegistry(
  bots: readonly PlaybackBot[]
): PlaybackBotRegistry {
  function getBot(botId: string): PlaybackBot | undefined {
    return bots.find((bot) => bot.id === botId)
  }

  function getMainBot(): PlaybackBot | undefined {
    return bots.find((bot) => bot.id === 'main')
  }

  function getIdleBot(preferredBotId?: string): PlaybackBot | undefined {
    if (preferredBotId !== undefined) {
      const preferred = getBot(preferredBotId)
      if (preferred !== undefined && preferred.getStatus() === 'idle') {
        return preferred
      }
    }
    return bots.find((bot) => bot.getStatus() === 'idle')
  }

  function getBotByVoiceChannel(
    guildId: string,
    voiceChannelId: string
  ): PlaybackBot | undefined {
    return bots.find((bot) => {
      const player = bot.manager.getPlayer(guildId)
      return player?.voiceChannelId === voiceChannelId
    })
  }

  return {
    bots,
    getBot,
    getMainBot,
    getIdleBot,
    getBotByVoiceChannel,
  }
}

let registry: PlaybackBotRegistry | undefined

export function setPlaybackBotRegistry(
  value: PlaybackBotRegistry | undefined
): void {
  registry = value
}

export function getPlaybackBotRegistry(): PlaybackBotRegistry {
  if (registry === undefined) {
    throw new Error('음악 봇 레지스트리가 초기화되지 않았어요.')
  }
  return registry
}

export function hasPlaybackBotRegistry(): boolean {
  return registry !== undefined
}

export type SubBotClient = {
  readonly botId: string
  readonly client: Client
  readonly stop: () => Promise<void>
}

const subBotClients: SubBotClient[] = []
const subBotPlayback: PlaybackBot[] = []
let mainPlaybackBot: PlaybackBot | undefined

export function registerMainPlaybackBot(
  client: Client,
  manager: LavalinkManager<CustomPlayer>
): void {
  mainPlaybackBot = {
    id: 'main',
    label: '메인',
    client,
    manager,
    getStatus: () => {
      if (!client.isReady()) return 'offline'
      const hasActive = Array.from(manager.players.values()).some(
        (p) => p.playing || p.connected
      )
      return hasActive ? 'playing' : 'idle'
    },
  }
  rebuildRegistry()
}

function rebuildRegistry(): void {
  const allBots = [mainPlaybackBot, ...subBotPlayback].filter(
    (b): b is PlaybackBot => b !== undefined
  )
  registry = createPlaybackBotRegistry(allBots)
}

export async function startSubBotClients(): Promise<readonly SubBotClient[]> {
  const configs = config.musicBots ?? []

  for (const botConfig of configs) {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    })

    try {
      await client.login(botConfig.token)
      logger.info(
        'Music',
        `서브 봇 로그인 완료: ${botConfig.label} (${botConfig.id})`
      )

      const manager = createLavalinkManager({
        clientId: botConfig.clientId,
        clientUsername: client.user?.username ?? botConfig.label,
        host: config.lavalink.host,
        password: config.lavalink.password,
        port: config.lavalink.port,
        secure: config.lavalink.secure,
        sendToShard: (guildId, payload) => {
          const guild = client.guilds.cache.get(guildId)
          if (guild === undefined) return
          if (guild.shard === undefined || guild.shard === null) return
          guild.shard.send(payload as never)
        },
      })

      const user = client.user
      if (user !== null) {
        await manager.init({ id: user.id, username: user.username })
      }

      client.on('raw', (data: unknown) => {
        try {
          manager.sendRawData(data as never)
        } catch (err) {
          logger.debug(
            'Music',
            `서브 봇 raw 전송 실패 (${botConfig.id}): ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      })

      const playbackBot: PlaybackBot = {
        id: botConfig.id,
        label: botConfig.label,
        client,
        manager,
        getStatus: () => {
          const players = manager.players
          const hasActive = Array.from(players.values()).some(
            (p) => p.playing || p.connected
          )
          if (!client.isReady()) return 'offline'
          return hasActive ? 'playing' : 'idle'
        },
      }
      subBotPlayback.push(playbackBot)

      subBotClients.push({
        botId: botConfig.id,
        client,
        stop: async () => {
          for (const [guildId] of manager.players) {
            try {
              await manager.destroyPlayer(guildId)
            } catch (err) {
              logger.debug(
                'Music',
                `서브 봇 player destroy 실패 (${botConfig.id}): ${
                  err instanceof Error ? err.message : String(err)
                }`
              )
            }
          }
          client.destroy()
          logger.info(
            'Music',
            `서브 봇 종료: ${botConfig.label} (${botConfig.id})`
          )
        },
      })
    } catch (err) {
      logger.error(
        'Music',
        `서브 봇 로그인 실패 (${botConfig.id}): ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  rebuildRegistry()
  return subBotClients
}

export function getSubBotPlaybackBots(): readonly PlaybackBot[] {
  return subBotPlayback
}

export async function stopAllSubBots(): Promise<void> {
  for (const stop of subBotClients.map((c) => c.stop)) {
    await stop().catch((e: unknown) =>
      logger.debug(
        'Music',
        `서브 봇 종료 에러: ${e instanceof Error ? e.message : String(e)}`
      )
    )
  }
  subBotClients.length = 0
  subBotPlayback.length = 0
}
