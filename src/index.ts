import { config } from './config'
import { CustomizedCommandClient } from './structures'
import { logger } from './utils/logger'
import { Client, GatewayIntentBits } from 'discord.js'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

const cts = new CustomizedCommandClient(client)

const start = async () => {
  await cts.setup()

  await client.login(config.token)

  await cts.getApplicationCommandsExtension()?.sync()
}

start().catch((err) => {
  logger.error(
    'Boot',
    `봇 시작 실패: ${err instanceof Error ? err.message : String(err)}`
  )
  process.exit(1)
})

function shutdown(signal: string): void {
  logger.info('Boot', `${signal} 수신, 종료하는 중...`)
  client.destroy()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
