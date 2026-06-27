import { formatWon } from '../config/korea'
import { createEconomyService } from '../features/economy/economy'
import {
  type RouletteBet,
  SLOT_SYMBOLS,
  playRollDice,
  playRoulette,
  playSlot,
} from '../features/game/game'
import {
  pickGamblingLoseMessage,
  pickGamblingWinMessage,
  pickSlotWinMessage,
} from '../features/game/messages'
import { logger } from '../utils/logger'
import { replyEphemeral } from '../utils/replies'
import { Extension, SubCommandGroup, option } from '@pikokr/command.ts'
import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js'
import { randomInt } from 'node:crypto'

const gamblingGroup = new SubCommandGroup({
  name: '도박',
  description: '베팅으로 크레딧을 늘려보세요!',
})
const economy = createEconomyService()
const rng = () => randomInt(0, 1000000) / 1000000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildContainer(
  blocks: string[],
  accentColor?: number
): ContainerBuilder {
  const container = new ContainerBuilder()
  if (accentColor !== undefined) {
    container.setAccentColor(accentColor)
  }
  for (let i = 0; i < blocks.length; i++) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(blocks[i])
    )
    if (i < blocks.length - 1) {
      container.addSeparatorComponents(
        new SeparatorBuilder()
          .setDivider(true)
          .setSpacing(SeparatorSpacingSize.Small)
      )
    }
  }
  return container
}

async function sendContainer(
  i: ChatInputCommandInteraction,
  container: ContainerBuilder
): Promise<void> {
  await i.reply({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  })
}

async function editContainer(
  i: ChatInputCommandInteraction,
  container: ContainerBuilder
): Promise<void> {
  try {
    await i.editReply({ components: [container] })
  } catch (err) {
    logger.warn(
      'Gambling',
      `editReply failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

function makeProgressBar(roll: number, target: number): string {
  const filled = Math.floor(roll / 5)
  const empty = 20 - filled
  const bar = '█'.repeat(filled) + '░'.repeat(empty)
  const pass = roll >= target
  return `${pass ? '🟩' : '🟥'} \`${bar}\` ${pass ? '🟩' : '🟥'}`
}

class GamblingExtensionClass extends Extension {
  @gamblingGroup.command({
    name: '롤다이스',
    description: '50 이상이 나오면 승리! 2배 배당의 간단한 도박.',
  })
  async rollDice(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '베팅',
      description: '베팅할 금액',
      min_value: 1,
      required: true,
    })
    bet: number
  ) {
    try {
      const balance = await economy.getBalance(i.user.id)
      if (balance.amount < bet) {
        await replyEphemeral(
          i,
          `잔액이 부족해요. 현재 잔액: ${formatWon(balance.amount)}`
        )
        return
      }

      await economy.transfer({
        amount: bet,
        fromUserId: i.user.id,
        toUserId: '0',
      })

      const target = 50
      const result = playRollDice({ random: rng, target, bet })

      if (result.win) {
        await economy.addBalance(i.user.id, result.payout)
      }

      await economy.recordGamble(i.user.id, bet, result.payout, result.win)
      try {
        await economy.recordQuestProgress(i.user.id, 'gamble')
      } catch (err) {
        logger.warn(
          'Gambling',
          `quest progress failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }

      await animateRollDice(
        i,
        result.roll,
        bet,
        result.win,
        result.payout,
        result.multiplier
      )
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '롤다이스 중 오류가 발생했어요.'
      )
    }
  }

  @gamblingGroup.command({
    name: '슬롯',
    description: '슬롯머신! 5칸 중 3칸 이상 같으면 당첨!',
  })
  async slot(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '베팅',
      description: '베팅할 금액',
      min_value: 1,
      required: true,
    })
    bet: number
  ) {
    try {
      const balance = await economy.getBalance(i.user.id)
      if (balance.amount < bet) {
        await replyEphemeral(
          i,
          `잔액이 부족해요. 현재 잔액: ${formatWon(balance.amount)}`
        )
        return
      }

      await economy.transfer({
        amount: bet,
        fromUserId: i.user.id,
        toUserId: '0',
      })

      const result = playSlot({ random: rng, bet })

      if (result.win) {
        await economy.addBalance(i.user.id, result.payout)
      }

      await economy.recordGamble(i.user.id, bet, result.payout, result.win)
      try {
        await economy.recordQuestProgress(i.user.id, 'gamble')
      } catch (err) {
        logger.warn(
          'Gambling',
          `quest progress failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }

      await animateSlot(
        i,
        result.reels,
        bet,
        result.win,
        result.matchCount,
        result.multiplier,
        result.payout
      )
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '슬롯 중 오류가 발생했어요.'
      )
    }
  }

  @gamblingGroup.command({
    name: '룰렛',
    description: '룰렛! 빨강/검정/초록/짝수/홀수 또는 특정 숫자(0~36)에 베팅!',
  })
  async roulette(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '베팅',
      description: '베팅할 금액',
      min_value: 1,
      required: true,
    })
    bet: number,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '선택',
      description: '빨강, 검정, 초록, 짝수, 홀수, 또는 숫자(0~36)',
      required: true,
    })
    betChoice: string
  ) {
    try {
      const balance = await economy.getBalance(i.user.id)
      if (balance.amount < bet) {
        await replyEphemeral(
          i,
          `잔액이 부족해요. 현재 잔액: ${formatWon(balance.amount)}`
        )
        return
      }

      const betType = parseRouletteBet(betChoice)
      if (betType === undefined) {
        await replyEphemeral(
          i,
          '선택이 올바르지 않아요. 빨강/검정/초록/짝수/홀수 또는 0~36 숫자를 입력하세요.'
        )
        return
      }

      await economy.transfer({
        amount: bet,
        fromUserId: i.user.id,
        toUserId: '0',
      })

      const result = playRoulette({ random: rng, bet, betType })

      if (result.win) {
        await economy.addBalance(i.user.id, result.payout)
      }

      await economy.recordGamble(i.user.id, bet, result.payout, result.win)
      try {
        await economy.recordQuestProgress(i.user.id, 'gamble')
      } catch (err) {
        logger.warn(
          'Gambling',
          `quest progress failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }

      const betLabel = typeof betType === 'number' ? `숫자 ${betType}` : betType
      await animateRoulette(
        i,
        result.number,
        result.color,
        bet,
        betLabel,
        result.win,
        result.payout
      )
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '룰렛 중 오류가 발생했어요.'
      )
    }
  }
}

async function animateSlot(
  i: ChatInputCommandInteraction,
  reels: string[],
  bet: number,
  win: boolean,
  matchCount: number,
  multiplier: number,
  payout: number
): Promise<void> {
  const userMention = `<@${i.user.id}>`
  const spinEmoji = SLOT_SYMBOLS.map((s) => s.emoji)

  for (let f = 0; f < 5; f++) {
    const r = Array.from(
      { length: 5 },
      () => spinEmoji[Math.floor(rng() * spinEmoji.length)]
    )
    const container = buildContainer([
      `# 🎰 슬롯머신`,
      `# ${r.join('')}`,
      `-# 굴러가는 중...`,
    ])
    if (f === 0) {
      await sendContainer(i, container)
    } else {
      await editContainer(i, container)
    }
    await sleep(250)
  }

  const accentColor = win ? 0x00ff00 : 0xff4444
  const matchLabel =
    matchCount >= 5
      ? '5칸 전부 일치'
      : matchCount >= 4
      ? '4칸 일치'
      : '3칸 일치'
  const resultText = win
    ? `# 🎉 ${matchLabel}!\n배당 **${multiplier}x** → ${formatWon(
        payout
      )} 획득!\n${pickSlotWinMessage(
        userMention,
        formatWon(payout),
        multiplier,
        matchCount
      )}`
    : `# 💥 아쉬워요\n베팅 ${formatWon(
        bet
      )}을 잃었어요.\n${pickGamblingLoseMessage(userMention, formatWon(bet))}`

  const container = buildContainer(
    [
      `# 🎰 슬롯머신`,
      `# ${reels[0]}${reels[1]}${reels[2]}${reels[3]}${reels[4]}`,
      resultText,
      `-# 베팅: ${formatWon(bet)} | 최대 ${matchCount}칸 일치`,
    ],
    accentColor
  )
  await editContainer(i, container)
}

async function animateRoulette(
  i: ChatInputCommandInteraction,
  finalNumber: number,
  finalColor: string,
  bet: number,
  betLabel: string,
  win: boolean,
  payout: number
): Promise<void> {
  const userMention = `<@${i.user.id}>`
  const redNumbers = [
    1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
  ]

  for (let f = 0; f < 6; f++) {
    const n = Math.floor(rng() * 37)
    const c = n === 0 ? '🟢' : redNumbers.includes(n) ? '🔴' : '⚫'
    const container = buildContainer([
      `# 🎡 룰렛`,
      `# ${c} ${n}`,
      `-# 회전 중...`,
    ])
    if (f === 0) {
      await sendContainer(i, container)
    } else {
      await editContainer(i, container)
    }
    await sleep(250)
  }

  const finalEmoji =
    finalColor === '초록' ? '🟢' : finalColor === '빨강' ? '🔴' : '⚫'
  const accentColor = win ? 0x00ff00 : 0xff4444
  const bigWin = win && payout >= bet * 5
  const resultText = win
    ? `# 🎉 적중!\n${finalEmoji} ${finalNumber} (${finalColor})\n${betLabel} → ${formatWon(
        payout
      )} 획득!\n${pickGamblingWinMessage(
        userMention,
        formatWon(payout),
        bigWin
      )}`
    : `# 💥 실패\n${finalEmoji} ${finalNumber} (${finalColor})\n베팅 ${formatWon(
        bet
      )}을 잃었어요.\n${pickGamblingLoseMessage(userMention, formatWon(bet))}`

  const container = buildContainer(
    [
      `# 🎡 룰렛`,
      `# ${finalEmoji} ${finalNumber}`,
      resultText,
      `-# 베팅: ${formatWon(bet)} | 선택: ${betLabel}`,
    ],
    accentColor
  )
  await editContainer(i, container)
}

async function animateRollDice(
  i: ChatInputCommandInteraction,
  finalRoll: number,
  bet: number,
  win: boolean,
  payout: number,
  multiplier: number
): Promise<void> {
  const userMention = `<@${i.user.id}>`
  for (let f = 0; f < 5; f++) {
    const n = Math.floor(rng() * 100) + 1
    const container = buildContainer([
      `# 🎲 롤다이스`,
      makeProgressBar(n, 50),
      `**${n}**`,
      `-# 굴리는 중... (목표: 50 이상)`,
    ])
    if (f === 0) {
      await sendContainer(i, container)
    } else {
      await editContainer(i, container)
    }
    await sleep(200)
  }

  const accentColor = win ? 0x00ff00 : 0xff4444
  const resultText = win
    ? `# 🎉 승리!\n결과: **${finalRoll}** (50 이상)\n배당 ${multiplier}x → ${formatWon(
        payout
      )} 획득!\n${pickGamblingWinMessage(
        userMention,
        formatWon(payout),
        multiplier >= 3
      )}`
    : `# 💥 패배\n결과: **${finalRoll}** (50 미만)\n베팅 ${formatWon(
        bet
      )}을 잃었어요.\n${pickGamblingLoseMessage(userMention, formatWon(bet))}`

  const container = buildContainer(
    [
      `# 🎲 롤다이스`,
      makeProgressBar(finalRoll, 50),
      resultText,
      `-# 베팅: ${formatWon(bet)} | 배당: ${multiplier}x`,
    ],
    accentColor
  )
  await editContainer(i, container)
}

function parseRouletteBet(input: string): RouletteBet | undefined {
  const lower = input.trim().toLowerCase()
  if (lower === '빨강' || lower === 'red') return 'red'
  if (lower === '검정' || lower === 'black') return 'black'
  if (lower === '초록' || lower === 'green') return 'green'
  if (lower === '짝수' || lower === 'even') return 'even'
  if (lower === '홀수' || lower === 'odd') return 'odd'
  const num = Number(input)
  if (Number.isInteger(num) && num >= 0 && num <= 36) return num
  return undefined
}

export const setup = async () => {
  return new GamblingExtensionClass()
}
