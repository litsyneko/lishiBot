import { createEconomyService } from '../features/economy/economy'
import { logger } from '../utils/logger'
import { Extension, listener } from '@pikokr/command.ts'
import type { Message } from 'discord.js'

const economy = createEconomyService()

class RewardExtensionClass extends Extension {
  @listener({ event: 'messageCreate' })
  async messageCreate(message: Message) {
    if (message.author.bot) return
    if (message.guild === null) return

    try {
      await economy.recordActivity(message.guild.id, message.author.id)
    } catch (err) {
      logger.error(
        'Reward',
        `활동 보상 기록 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
}

export const setup = async () => {
  return new RewardExtensionClass()
}
