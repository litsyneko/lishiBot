import { config } from './config'
import { CustomizedCommandClient } from './structures'
import { logger } from './utils/logger'
import { Client, GatewayIntentBits, Partials } from 'discord.js'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.MessageContent,
  ],
  // 캐시에 없는(재시작 이전) 메시지의 삭제/수정/반응 이벤트도 받기 위한 설정.
  // 파셜 객체는 각 리스너에서 fetch 후 사용해야 한다.
  partials: [
    Partials.Message,
    Partials.Reaction,
    Partials.User,
    Partials.GuildMember,
  ],
})

// 모듈 전체가 이벤트 리스너를 등록해 Node 기본 한도(10) 초과 — 경고 방지 목적, 누수 아님
client.setMaxListeners(50)

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
