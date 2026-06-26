import { Extension, SubCommandGroup, option } from '@pikokr/command.ts'
import { ApplicationCommandOptionType, ChatInputCommandInteraction } from 'discord.js'
import { createEconomyService } from '../features/economy/economy'
import { replyEphemeral } from '../utils/replies'

const economyGroup = new SubCommandGroup({ name: '경제', description: 'FullMoon 경제 명령어' })

const economy = createEconomyService()

class EconomyExtensionClass extends Extension {
  @economyGroup.command({ name: '잔액', description: '내 잔액을 확인합니다.' })
  async balance(i: ChatInputCommandInteraction) {
    try {
      const result = await economy.getBalance(i.user.id)
      await replyEphemeral(i, result.label)
    } catch (err) {
      await replyEphemeral(i, err instanceof Error ? err.message : '잔액 조회 중 오류가 발생했어요.')
    }
  }

  @economyGroup.command({ name: '출석', description: '매일 출석 보상을 받습니다.' })
  async attendance(i: ChatInputCommandInteraction) {
    try {
      const result = await economy.claimAttendance({
        now: new Date(),
        userId: i.user.id,
      })
      await replyEphemeral(i, result.message)
    } catch (err) {
      await replyEphemeral(i, err instanceof Error ? err.message : '출석 처리 중 오류가 발생했어요.')
    }
  }

  @economyGroup.command({ name: '송금', description: '다른 사용자에게 원화를 송금합니다.' })
  async transfer(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.User,
      name: '받는사람',
      description: '송금 받을 사용자',
      required: true,
    })
    _target: unknown,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '금액',
      description: '송금할 원화 금액',
      min_value: 1,
      required: true,
    })
    amount: number,
  ) {
    try {
      const targetUser = i.options.getUser('받는사람', true)
      const result = await economy.transfer({
        amount,
        fromUserId: i.user.id,
        toUserId: targetUser.id,
      })
      await replyEphemeral(i, result.message)
    } catch (err) {
      await replyEphemeral(i, err instanceof Error ? err.message : '송금 중 오류가 발생했어요.')
    }
  }
}

export const setup = async () => {
  return new EconomyExtensionClass()
}
