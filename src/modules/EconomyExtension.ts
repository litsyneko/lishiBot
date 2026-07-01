import { formatWon } from '../config/korea'
import { createEconomyService } from '../features/economy/economy'
import { renderLevelCard } from '../features/economy/levelCard'
import {
  pickAttendanceMessage,
  pickLotteryMessage,
} from '../features/game/messages'
import { replyEphemeral, replyPublic } from '../utils/replies'
import { Extension, SubCommandGroup, option } from '@pikokr/command.ts'
import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js'

const economyGroup = new SubCommandGroup({
  name: '경제',
  description: 'FullMoon 경제 명령어',
})

const economy = createEconomyService()

class EconomyExtensionClass extends Extension {
  @economyGroup.command({ name: '잔액', description: '내 잔액을 확인합니다.' })
  async balance(i: ChatInputCommandInteraction) {
    try {
      const result = await economy.getBalance(i.user.id)
      await replyEphemeral(i, result.label)
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '잔액 조회 중 오류가 발생했어요.'
      )
    }
  }

  @economyGroup.command({
    name: '출석',
    description: '매일 출석 보상을 받습니다.',
  })
  async attendance(i: ChatInputCommandInteraction) {
    try {
      await economy.claimAttendance({
        now: new Date(),
        userId: i.user.id,
      })
      const msg = pickAttendanceMessage(`<@${i.user.id}>`)
      await replyPublic(i, msg)
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '출석 처리 중 오류가 발생했어요.'
      )
    }
  }

  @economyGroup.command({
    name: '송금',
    description: '다른 사용자에게 원화를 송금합니다.',
  })
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
    amount: number
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
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '송금 중 오류가 발생했어요.'
      )
    }
  }

  @economyGroup.command({
    name: '순위',
    description: '도박 수익/손실 순위를 확인합니다.',
  })
  async ranking(i: ChatInputCommandInteraction) {
    try {
      const ranking = await economy.getRanking(10)
      if (ranking.length === 0) {
        await replyPublic(i, '아직 도박 기록이 없어요.')
        return
      }

      const lines = ranking.map((r, idx) => {
        const netLabel = r.net >= 0 ? `+${formatWon(r.net)}` : formatWon(r.net)
        return `${idx + 1}. <@${r.userId}> | 순수익: ${netLabel} | 승률: ${
          r.winRate
        }% (${r.winCount}/${r.betCount})`
      })

      await replyPublic(i, `📊 **도박 순위 TOP 10**\n\n${lines.join('\n')}`)
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '순위 조회 중 오류가 발생했어요.'
      )
    }
  }

  @economyGroup.command({
    name: '퀘스트',
    description: '일일 퀘스트 진행도를 확인하거나 보상을 받습니다.',
  })
  async quest(i: ChatInputCommandInteraction) {
    try {
      const progress = await economy.getQuestProgress(i.user.id)
      if (progress.claimed) {
        await replyEphemeral(
          i,
          '오늘 퀘스트는 이미 완료했어요! 내일 다시 도전하세요.'
        )
        return
      }

      const gambleDone = progress.gambleCount >= 3
      const rpsDone = progress.rpsCount >= 1
      const allDone = gambleDone && rpsDone

      const status = `📋 **일일 퀘스트**\n\n${
        gambleDone ? '✅' : '⬜'
      } 도박 3회 (${progress.gambleCount}/3)\n${
        rpsDone ? '✅' : '⬜'
      } 가위바위보 1회 (${progress.rpsCount}/1)\n\n보상: ${formatWon(5000)}`

      if (allDone) {
        const result = await economy.claimQuestReward(i.user.id)
        await replyPublic(i, `${status}\n\n${result.message}`)
      } else {
        await replyEphemeral(i, status)
      }
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '퀘스트 조회 중 오류가 발생했어요.'
      )
    }
  }

  @economyGroup.command({
    name: '복권',
    description: '주 1회 무료 복권! 대박을 노려보세요.',
  })
  async lottery(i: ChatInputCommandInteraction) {
    try {
      const result = await economy.claimLottery(i.user.id)
      const msg = pickLotteryMessage(
        `<@${i.user.id}>`,
        result.prize,
        formatWon(result.prize)
      )
      await replyPublic(i, `🎟️ **주간 복권**\n\n${msg}`)
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '복권 참여 중 오류가 발생했어요.'
      )
    }
  }

  @economyGroup.command({
    name: '보상랭킹',
    description: '선착 보상 수령 랭킹을 확인합니다.',
  })
  async dropRanking(i: ChatInputCommandInteraction) {
    try {
      const guild = i.guild
      if (guild === null) return

      const ranking = await economy.getDropLeaderboard(guild.id, 10)
      if (ranking.length === 0) {
        await replyPublic(i, '아직 선착 보상 수령 기록이 없어요.')
        return
      }

      const lines = ranking.map((r, idx) => {
        return `${idx + 1}. <@${r.userId}> | ${
          r.totalClaimed
        }회 수령 | ${formatWon(r.totalAmount)}`
      })

      await replyPublic(
        i,
        `🎁 **선착 보상 랭킹 TOP 10**\n\n${lines.join('\n')}`
      )
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '랭킹 조회 중 오류가 발생했어요.'
      )
    }
  }

  @economyGroup.command({
    name: '레벨',
    description: '내 레벨과 경험치를 확인합니다.',
  })
  async level(i: ChatInputCommandInteraction) {
    try {
      const result = await economy.getLevel(i.user.id)
      const xpNeeded = result.level * result.level * 300
      const [balance, bankBalance] = await Promise.all([
        economy.getBalance(i.user.id),
        economy.getBankBalance(i.user.id),
      ])
      const avatarUrl = i.user.displayAvatarURL({
        extension: 'png',
        size: 256,
      })

      const png = await renderLevelCard({
        level: result.level,
        xp: result.xp,
        xpNeeded,
        balance: balance.amount,
        bankBalance,
        username: i.user.username,
        avatarUrl,
      })

      const attachment = new AttachmentBuilder(png, {
        name: `level-${i.user.id}.png`,
      })

      const caption = `📊 **${i.user.username}** 님 — 레벨 **${
        result.level
      }** · XP ${result.xp.toLocaleString()} / ${xpNeeded.toLocaleString()}`

      if (i.deferred || i.replied) {
        await i.followUp({
          content: caption,
          files: [attachment],
        })
        return
      }
      await i.reply({
        content: caption,
        files: [attachment],
        flags: MessageFlags.SuppressEmbeds,
      })
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '레벨 조회 중 오류가 발생했어요.'
      )
    }
  }

  @economyGroup.command({
    name: '은행',
    description: '은행 잔액을 확인하고 입금/출금/이자 수령을 합니다.',
  })
  async bank(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '기능',
      description: '조회 / 입금 / 출금 / 이자',
      choices: [
        { name: '조회', value: '조회' },
        { name: '입금', value: '입금' },
        { name: '출금', value: '출금' },
        { name: '이자', value: '이자' },
      ],
      required: true,
    })
    action: string,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '금액',
      description: '입금/출금 금액',
      min_value: 1,
      required: false,
    })
    amount: number
  ) {
    try {
      if (action === '조회') {
        const bankBalance = await economy.getBankBalance(i.user.id)
        const balance = await economy.getBalance(i.user.id)
        await replyPublic(
          i,
          `🏦 **은행 잔액**\n\n지갑: ${formatWon(
            balance.amount
          )}\n은행: ${formatWon(bankBalance)}\n이자율: 일 0.5%`
        )
        return
      }

      if (action === '이자') {
        const result = await economy.claimInterest(i.user.id)
        await replyPublic(i, `🏦 ${result.message}`)
        return
      }

      if (amount === undefined) {
        await replyEphemeral(i, '금액을 입력해 주세요.')
        return
      }

      if (action === '입금') {
        const result = await economy.bankDeposit(i.user.id, amount)
        await replyPublic(
          i,
          `🏦 ${formatWon(amount)}을 입금했어요.\n지갑: ${formatWon(
            result.balance
          )} | 은행: ${formatWon(result.bankBalance)}`
        )
        return
      }

      if (action === '출금') {
        const result = await economy.bankWithdraw(i.user.id, amount)
        await replyPublic(
          i,
          `🏦 ${formatWon(amount)}을 출금했어요.\n지갑: ${formatWon(
            result.balance
          )} | 은행: ${formatWon(result.bankBalance)}`
        )
        return
      }
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '은행 처리 중 오류가 발생했어요.'
      )
    }
  }
}

export const setup = async () => {
  return new EconomyExtensionClass()
}
