import { formatWon } from '../config/korea'
import { createEconomyService } from '../features/economy/economy'
import {
  type BlackjackHand,
  type Card,
  type RouletteBet,
  SLOT_SYMBOLS,
  blackjackPayout,
  calculateHand,
  createDeck,
  dealCard,
  determineBlackjackOutcome,
  formatCard,
  formatHand,
  playDealer,
  playRollDice,
  playRoulette,
  playSlot,
  shuffleDeck,
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
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  ComponentType,
  ContainerBuilder,
  type Message,
  type MessageComponentInteraction,
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

  @gamblingGroup.command({
    name: '블랙잭',
    description: '21에 가까운 쪽이 승리! 히트/스탠드로 카드를 뽑아보세요.',
  })
  async blackjack(
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

      await runBlackjackRound(i, bet)
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '블랙잭 중 오류가 발생했어요.'
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

const BLACKJACK_HIT_ID = 'bj_hit'
const BLACKJACK_STAND_ID = 'bj_stand'
const BLACKJACK_BUTTON_TIMEOUT_MS = 60_000

function makeBlackjackButtons(): ActionRowBuilder<ButtonBuilder> {
  const hit = new ButtonBuilder()
    .setCustomId(BLACKJACK_HIT_ID)
    .setLabel('히트')
    .setStyle(ButtonStyle.Primary)
  const stand = new ButtonBuilder()
    .setCustomId(BLACKJACK_STAND_ID)
    .setLabel('스탠드')
    .setStyle(ButtonStyle.Secondary)
  return new ActionRowBuilder<ButtonBuilder>().addComponents(hit, stand)
}

function makeDisabledBlackjackButtons(
  disabledLabel?: string
): ActionRowBuilder<ButtonBuilder> {
  const hit = new ButtonBuilder()
    .setCustomId(BLACKJACK_HIT_ID)
    .setLabel(disabledLabel ?? '히트')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true)
  const stand = new ButtonBuilder()
    .setCustomId(BLACKJACK_STAND_ID)
    .setLabel('스탠드')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true)
  return new ActionRowBuilder<ButtonBuilder>().addComponents(hit, stand)
}

function formatDealerUp(hand: BlackjackHand, reveal: boolean): string {
  if (reveal) {
    return `${formatHand(hand.cards)} (합 ${hand.total})`
  }
  const up = hand.cards[0]
  if (up === undefined) return '카드 없음'
  return `${formatCard(up)} / ❓`
}

function buildBlackjackContainer(
  bet: number,
  playerHand: BlackjackHand,
  dealerHand: BlackjackHand,
  revealDealer: boolean,
  footer: string,
  accentColor?: number,
  buttons?: ActionRowBuilder<ButtonBuilder>
): ContainerBuilder {
  const container = buildContainer(
    [
      `# 🃏 블랙잭`,
      `**딜러**: ${formatDealerUp(dealerHand, revealDealer)}`,
      `**${playerHandLabel(playerHand)}**: ${formatHand(
        playerHand.cards
      )} (합 ${playerHand.total})`,
      footer,
      `-# 베팅: ${formatWon(bet)}`,
    ],
    accentColor
  )
  if (buttons !== undefined) {
    container.addActionRowComponents(buttons)
  }
  return container
}

function playerHandLabel(hand: BlackjackHand): string {
  if (hand.isBlackjack) return '플레이어 🎉'
  if (hand.isBust) return '플레이어 💥'
  return '플레이어'
}

async function runBlackjackRound(
  i: ChatInputCommandInteraction,
  bet: number
): Promise<void> {
  const userMention = `<@${i.user.id}>`
  let deck = shuffleDeck(createDeck(), rng)

  let playerCards: Card[] = []
  let dealerCards: Card[] = []
  for (let c = 0; c < 2; c++) {
    const pDeal = dealCard(deck)
    playerCards = [...playerCards, pDeal.card]
    deck = pDeal.remaining
    const dDeal = dealCard(deck)
    dealerCards = [...dealerCards, dDeal.card]
    deck = dDeal.remaining
  }

  let playerHand = calculateHand(playerCards)
  const dealerHandInitial = calculateHand(dealerCards)

  if (playerHand.isBlackjack || dealerHandInitial.isBlackjack) {
    const dealerFinal = playDealer(deck, dealerHandInitial).hand
    await settleBlackjack(i, bet, userMention, playerHand, dealerFinal, true)
    return
  }

  const introContainer = buildBlackjackContainer(
    bet,
    playerHand,
    dealerHandInitial,
    false,
    '히트로 카드를 한 장 더 받거나, 스탠드로 멈출 수 있어요.',
    undefined,
    makeBlackjackButtons()
  )
  await i.reply({
    components: [introContainer],
    flags: MessageFlags.IsComponentsV2,
  })
  const replyMessage = await i.fetchReply()

  while (!playerHand.isBust) {
    const component = await awaitBlackjackButton(replyMessage)
    if (component === null) {
      const timeoutContainer = buildBlackjackContainer(
        bet,
        playerHand,
        dealerHandInitial,
        true,
        '시간 초과로 기권 처리되었어요.',
        0xff4444
      )
      await i.editReply({ components: [timeoutContainer] })
      try {
        await economy.recordGamble(i.user.id, bet, 0, false)
        await economy.recordQuestProgress(i.user.id, 'gamble')
      } catch (err) {
        logger.warn(
          'Gambling',
          `blackjack record failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
      return
    }

    if (component.customId === BLACKJACK_STAND_ID) {
      await component.deferUpdate()
      const { hand: dealerFinal } = playDealer(deck, dealerHandInitial)
      await settleBlackjack(i, bet, userMention, playerHand, dealerFinal, true)
      return
    }

    const dealt = dealCard(deck)
    playerCards = [...playerCards, dealt.card]
    deck = dealt.remaining
    playerHand = calculateHand(playerCards)

    if (playerHand.isBust) {
      await component.deferUpdate()
      await settleBlackjack(
        i,
        bet,
        userMention,
        playerHand,
        dealerHandInitial,
        true
      )
      return
    }

    const updateContainer = buildBlackjackContainer(
      bet,
      playerHand,
      dealerHandInitial,
      false,
      '히트 or 스탠드?',
      undefined,
      makeBlackjackButtons()
    )
    try {
      await component.update({ components: [updateContainer] })
    } catch (err) {
      logger.warn(
        'Gambling',
        `blackjack update failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
}

async function awaitBlackjackButton(
  replyMessage: Message
): Promise<MessageComponentInteraction | null> {
  try {
    return await replyMessage.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: BLACKJACK_BUTTON_TIMEOUT_MS,
    })
  } catch {
    return null
  }
}

async function settleBlackjack(
  i: ChatInputCommandInteraction,
  bet: number,
  userMention: string,
  playerHand: BlackjackHand,
  dealerHand: BlackjackHand,
  revealDealer: boolean
): Promise<void> {
  const outcome = determineBlackjackOutcome(playerHand, dealerHand)
  const { multiplier, payout, win } = blackjackPayout(outcome, bet)

  if (win) {
    await economy.addBalance(i.user.id, payout)
  }
  await economy.recordGamble(i.user.id, bet, payout, win)
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

  const resultText = buildBlackjackResultText(
    outcome,
    userMention,
    bet,
    multiplier,
    payout
  )
  const accentColor = win ? 0x00ff00 : 0xff4444

  const finalContainer = buildBlackjackContainer(
    bet,
    playerHand,
    dealerHand,
    revealDealer,
    resultText,
    accentColor
  )
  const disabledButtons = makeDisabledBlackjackButtons(
    outcome === 'player-bust' ? '버스트' : '완료'
  )
  finalContainer.addActionRowComponents(disabledButtons)
  try {
    await i.editReply({ components: [finalContainer] })
  } catch (err) {
    logger.warn(
      'Gambling',
      `blackjack settle failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

function buildBlackjackResultText(
  outcome: ReturnType<typeof determineBlackjackOutcome>,
  userMention: string,
  bet: number,
  multiplier: number,
  payout: number
): string {
  switch (outcome) {
    case 'player-blackjack':
      return `# 🎉 블랙잭!\n배당 ${multiplier}x → ${formatWon(
        payout
      )} 획득!\n${pickGamblingWinMessage(userMention, formatWon(payout), true)}`
    case 'player-win':
      return `# 🎉 승리!\n${multiplier}x → ${formatWon(
        payout
      )} 획득!\n${pickGamblingWinMessage(
        userMention,
        formatWon(payout),
        false
      )}`
    case 'push':
      return `# 🤝 무승부\n베팅 ${formatWon(bet)} 돌려드렸어요.`
    case 'dealer-win':
      return `# 💥 패배\n딜러 승리. 베팅 ${formatWon(
        bet
      )}을 잃었어요.\n${pickGamblingLoseMessage(userMention, formatWon(bet))}`
    case 'player-bust':
      return `# 💥 버스트\n합이 21을 넘겼어요. 베팅 ${formatWon(
        bet
      )}을 잃었어요.\n${pickGamblingLoseMessage(userMention, formatWon(bet))}`
  }
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
