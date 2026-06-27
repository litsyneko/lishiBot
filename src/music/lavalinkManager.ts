import { CustomPlayer } from './customPlayer'
import { LavalinkManager } from 'lavalink-client'

export type LavalinkNodeInput = {
  readonly host: string
  readonly password: string
  readonly port: number
  readonly secure: boolean
}

export type LavalinkNodeOptions = {
  readonly authorization: string
  readonly host: string
  readonly id: string
  readonly port: number
  readonly secure: boolean
}

export type LavalinkManagerInput = {
  readonly clientId: string
  readonly clientUsername: string
  readonly host: string
  readonly password: string
  readonly port: number
  readonly secure: boolean
  readonly sendToShard: (guildId: string, payload: unknown) => void
}

export function createLavalinkNodeOptions(
  input: LavalinkNodeInput
): LavalinkNodeOptions {
  if (input.host.trim().length === 0) {
    throw new Error('Lavalink 호스트를 입력해 주세요.')
  }

  if (input.password.trim().length === 0) {
    throw new Error('Lavalink 비밀번호를 입력해 주세요.')
  }

  return {
    authorization: input.password,
    host: input.host,
    id: `fullmoon-${input.host}-${input.port}`,
    port: input.port,
    secure: input.secure,
  }
}

export function createLavalinkManager(
  input: LavalinkManagerInput
): LavalinkManager<CustomPlayer> {
  const nodeOptions = createLavalinkNodeOptions(input)

  return new LavalinkManager({
    client: { id: input.clientId, username: input.clientUsername },
    nodes: [nodeOptions],
    autoSkip: true,
    playerClass: CustomPlayer,
    playerOptions: {
      applyVolumeAsFilter: true,
      defaultSearchPlatform: 'ytsearch',
      onDisconnect: {
        autoReconnect: true,
      },
      onEmptyQueue: {
        destroyAfterMs: 300000,
      },
    },
    queueOptions: {
      maxPreviousTracks: 50,
    },
    sendToShard: (guildId, payload) => {
      input.sendToShard(guildId, payload)
    },
  })
}
