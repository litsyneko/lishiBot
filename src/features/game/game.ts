export type RandomSource = () => number

export type DiceRollInput = {
  readonly random: RandomSource
  readonly sides: number
}

export type DiceRoll = {
  readonly label: string
  readonly value: number
}

export type RockPaperScissorsMove = '가위' | '바위' | '보'

export type RockPaperScissorsResult = 'draw' | 'lose' | 'win'

export type RockPaperScissorsInput = {
  readonly move: RockPaperScissorsMove
  readonly random: RandomSource
}

export type RockPaperScissorsRound = {
  readonly botMove: RockPaperScissorsMove
  readonly message: string
  readonly result: RockPaperScissorsResult
}

const moves = ['가위', '바위', '보'] as const
const rollDiceHouseEdgeBase = 99
const rollDiceMaxMultiplier = 10

export function flipCoin(random: RandomSource): '앞면' | '뒷면' {
  return random() < 0.5 ? '앞면' : '뒷면'
}

export function rollDice(input: DiceRollInput): DiceRoll {
  if (!Number.isInteger(input.sides) || input.sides < 2) {
    throw new Error('주사위 면 수는 2 이상이어야 해요.')
  }

  const value = Math.floor(input.random() * input.sides) + 1
  return {
    label: `주사위 결과: ${value}`,
    value,
  }
}

export function playRockPaperScissors(
  input: RockPaperScissorsInput
): RockPaperScissorsRound {
  const botMove = pickMove(input.random)
  const result = compareMoves(input.move, botMove)
  const resultLabel =
    result === 'draw'
      ? '비겼어요.'
      : result === 'win'
      ? '승리했어요!'
      : '패배했어요.'

  return {
    botMove,
    message: `${resultLabel} 내 선택: ${botMove} / 사용자 선택: ${input.move}`,
    result,
  }
}

function pickMove(random: RandomSource): RockPaperScissorsMove {
  const index = Math.min(Math.floor(random() * moves.length), moves.length - 1)
  switch (index) {
    case 0:
      return '가위'
    case 1:
      return '바위'
    default:
      return '보'
  }
}

function compareMoves(
  userMove: RockPaperScissorsMove,
  botMove: RockPaperScissorsMove
): RockPaperScissorsResult {
  if (userMove === botMove) {
    return 'draw'
  }

  if (
    (userMove === '가위' && botMove === '보') ||
    (userMove === '바위' && botMove === '가위') ||
    (userMove === '보' && botMove === '바위')
  ) {
    return 'win'
  }

  return 'lose'
}

export type RollDiceInput = {
  readonly random: RandomSource
  readonly target: number
  readonly bet: number
}

export type RollDiceResult = {
  readonly roll: number
  readonly win: boolean
  readonly multiplier: number
  readonly payout: number
  readonly message: string
}

export function playRollDice(input: RollDiceInput): RollDiceResult {
  const { random, target, bet } = input

  if (!Number.isInteger(target) || target < 2 || target > 98) {
    throw new Error('목표 숫자는 2~98 사이여야 해요.')
  }
  if (!Number.isInteger(bet) || bet <= 0) {
    throw new Error('베팅 금액은 1원 이상이어야 해요.')
  }

  const winningOutcomes = 101 - target
  const rawMultiplier = rollDiceHouseEdgeBase / winningOutcomes
  const multiplier = Math.min(
    Math.floor(rawMultiplier * 100) / 100,
    rollDiceMaxMultiplier
  )
  const roll = Math.floor(random() * 100) + 1
  const win = roll >= target
  const payout = win ? Math.floor(bet * multiplier) : 0

  return {
    roll,
    win,
    multiplier,
    payout,
    message: win
      ? `🎯 ${target} 이상! 결과: ${roll}\n배당 ${multiplier}x → ${payout.toLocaleString()}원 획득!`
      : `💥 ${target} 미만! 결과: ${roll}\n베팅 ${bet.toLocaleString()}원을 잃었어요.`,
  }
}

export type SlotSymbol = {
  readonly emoji: string
  readonly weight: number
  readonly payout: number
}

export const SLOT_SYMBOLS: readonly SlotSymbol[] = [
  { emoji: '🍒', weight: 30, payout: 2 },
  { emoji: '🍋', weight: 25, payout: 3 },
  { emoji: '🍊', weight: 20, payout: 4 },
  { emoji: '🍇', weight: 12, payout: 6 },
  { emoji: '🔔', weight: 8, payout: 10 },
  { emoji: '💎', weight: 4, payout: 15 },
  { emoji: '7️⃣', weight: 1, payout: 20 },
]

export type SlotResult = {
  readonly reels: string[]
  readonly win: boolean
  readonly matchCount: number
  readonly multiplier: number
  readonly payout: number
  readonly message: string
}

export function playSlot(input: {
  random: RandomSource
  bet: number
}): SlotResult {
  const { random, bet } = input

  if (!Number.isInteger(bet) || bet <= 0) {
    throw new Error('베팅 금액은 1원 이상이어야 해요.')
  }

  const reels = [
    spinReel(random),
    spinReel(random),
    spinReel(random),
    spinReel(random),
    spinReel(random),
  ]

  const matchCount = countMaxSymbol(reels)
  const matchedSymbol = findDominantSymbol(reels, matchCount)

  let win = false
  let multiplier = 0
  let payout = 0

  if (matchCount >= 5 && matchedSymbol !== undefined) {
    win = true
    multiplier = matchedSymbol.payout * 3
    payout = Math.floor(bet * multiplier)
  } else if (matchCount >= 4 && matchedSymbol !== undefined) {
    win = true
    multiplier = Math.floor(matchedSymbol.payout * 1.5 * 100) / 100
    payout = Math.floor(bet * multiplier)
  } else if (matchCount >= 3 && matchedSymbol !== undefined) {
    win = true
    multiplier = matchedSymbol.payout
    payout = Math.floor(bet * multiplier)
  }

  const matchLabel =
    matchCount >= 5
      ? '5칸 전부 일치'
      : matchCount >= 4
      ? '4칸 일치'
      : matchCount >= 3
      ? '3칸 일치'
      : '미당첨'

  return {
    reels,
    win,
    matchCount,
    multiplier,
    payout,
    message: win
      ? `${matchLabel}! 배당 ${multiplier}x → ${payout.toLocaleString()}원 획득!`
      : `아쉬워요. 베팅 ${bet.toLocaleString()}원을 잃었어요.`,
  }
}

function countMaxSymbol(reels: string[]): number {
  const counts = new Map<string, number>()
  for (const r of reels) {
    counts.set(r, (counts.get(r) ?? 0) + 1)
  }
  return Math.max(...counts.values())
}

function findDominantSymbol(
  reels: string[],
  minCount: number
): SlotSymbol | undefined {
  const counts = new Map<string, number>()
  for (const r of reels) {
    counts.set(r, (counts.get(r) ?? 0) + 1)
  }
  let bestEmoji: string | undefined
  let bestCount = 0
  for (const [emoji, count] of counts) {
    if (count > bestCount) {
      bestCount = count
      bestEmoji = emoji
    }
  }
  if (bestCount >= minCount && bestEmoji !== undefined) {
    return SLOT_SYMBOLS.find((s) => s.emoji === bestEmoji)
  }
  return undefined
}

function spinReel(random: RandomSource): string {
  const totalWeight = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0)
  let roll = random() * totalWeight
  for (const symbol of SLOT_SYMBOLS) {
    roll -= symbol.weight
    if (roll <= 0) return symbol.emoji
  }
  return SLOT_SYMBOLS[0].emoji
}

export type RouletteBet = 'red' | 'black' | 'green' | 'even' | 'odd' | number

export type RouletteResult = {
  readonly number: number
  readonly color: string
  readonly win: boolean
  readonly payout: number
  readonly message: string
}

export function playRoulette(input: {
  random: RandomSource
  bet: number
  betType: RouletteBet
}): RouletteResult {
  const { random, bet, betType } = input

  if (!Number.isInteger(bet) || bet <= 0) {
    throw new Error('베팅 금액은 1원 이상이어야 해요.')
  }

  const number = Math.floor(random() * 37)
  const color = rouletteColor(number)

  let win = false
  let multiplier = 0

  if (typeof betType === 'number') {
    win = betType === number
    multiplier = 36
  } else if (betType === 'red') {
    win = color === '빨강'
    multiplier = 2
  } else if (betType === 'black') {
    win = color === '검정'
    multiplier = 2
  } else if (betType === 'green') {
    win = color === '초록'
    multiplier = 36
  } else if (betType === 'even') {
    win = number !== 0 && number % 2 === 0
    multiplier = 2
  } else if (betType === 'odd') {
    win = number % 2 === 1
    multiplier = 2
  }

  const payout = win ? bet * multiplier : 0

  return {
    number,
    color,
    win,
    payout,
    message: win
      ? `🎡 결과: ${number} (${color})\n${String(
          betType
        )} 적중! ${multiplier}x → ${payout.toLocaleString()}원 획득!`
      : `🎡 결과: ${number} (${color})\n${String(
          betType
        )} 실패. 베팅 ${bet.toLocaleString()}원을 잃었어요.`,
  }
}

function rouletteColor(number: number): string {
  if (number === 0) return '초록'
  const redNumbers = [
    1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
  ]
  return redNumbers.includes(number) ? '빨강' : '검정'
}

export type CardSuit = '♠' | '♥' | '♦' | '♣'

export type CardRank =
  | 'A'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '10'
  | 'J'
  | 'Q'
  | 'K'

export type Card = {
  readonly rank: CardRank
  readonly suit: CardSuit
  readonly value: number
}

export type BlackjackHand = {
  readonly cards: readonly Card[]
  readonly total: number
  readonly soft: boolean
  readonly isBust: boolean
  readonly isBlackjack: boolean
}

export type BlackjackAction = 'hit' | 'stand'

export type BlackjackOutcome =
  | 'player-blackjack'
  | 'player-win'
  | 'push'
  | 'dealer-win'
  | 'player-bust'

export type BlackjackResult = {
  readonly outcome: BlackjackOutcome
  readonly playerHand: BlackjackHand
  readonly dealerHand: BlackjackHand
  readonly multiplier: number
  readonly payout: number
  readonly win: boolean
}

const cardRanks: readonly CardRank[] = [
  'A',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
]
const cardSuits: readonly CardSuit[] = ['♠', '♥', '♦', '♣']

export function cardValue(rank: CardRank): number {
  if (rank === 'A') return 11
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10
  return Number(rank)
}

export function createDeck(): Card[] {
  const deck: Card[] = []
  for (const suit of cardSuits) {
    for (const rank of cardRanks) {
      deck.push({ rank, suit, value: cardValue(rank) })
    }
  }
  return deck
}

export function shuffleDeck(
  deck: readonly Card[],
  random: RandomSource
): Card[] {
  const next = [...deck]
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = next[i]
    next[i] = next[j]
    next[j] = tmp
  }
  return next
}

export function dealCard(deck: readonly Card[]): {
  readonly card: Card
  readonly remaining: Card[]
} {
  if (deck.length === 0) {
    throw new Error('덱이 비었어요.')
  }
  const [card, ...remaining] = deck
  return { card, remaining }
}

export function calculateHand(cards: readonly Card[]): BlackjackHand {
  let total = 0
  let aces = 0
  for (const card of cards) {
    total += card.value
    if (card.rank === 'A') aces++
  }
  let soft = false
  while (total > 21 && aces > 0) {
    total -= 10
    aces--
  }
  if (aces > 0 && total <= 21) {
    soft = true
  }
  return {
    cards,
    total,
    soft,
    isBust: total > 21,
    isBlackjack: cards.length === 2 && total === 21,
  }
}

export function playDealer(
  deck: readonly Card[],
  dealerHand: BlackjackHand
): { readonly hand: BlackjackHand; readonly remaining: Card[] } {
  let remaining = [...deck]
  let cards = [...dealerHand.cards]
  let hand = calculateHand(cards)
  while (hand.total < 17 || (hand.total === 17 && hand.soft)) {
    const dealt = dealCard(remaining)
    cards = [...cards, dealt.card]
    remaining = dealt.remaining
    hand = calculateHand(cards)
  }
  return { hand, remaining }
}

export function determineBlackjackOutcome(
  playerHand: BlackjackHand,
  dealerHand: BlackjackHand
): BlackjackOutcome {
  if (playerHand.isBust) return 'player-bust'
  if (dealerHand.isBust) return 'player-win'
  if (playerHand.isBlackjack && !dealerHand.isBlackjack) {
    return 'player-blackjack'
  }
  if (dealerHand.isBlackjack && !playerHand.isBlackjack) {
    return 'dealer-win'
  }
  if (playerHand.total > dealerHand.total) return 'player-win'
  if (playerHand.total < dealerHand.total) return 'dealer-win'
  return 'push'
}

export function blackjackPayout(
  outcome: BlackjackOutcome,
  bet: number
): {
  readonly multiplier: number
  readonly payout: number
  readonly win: boolean
} {
  if (!Number.isInteger(bet) || bet <= 0) {
    throw new Error('베팅 금액은 1원 이상이어야 해요.')
  }
  if (outcome === 'player-blackjack') {
    const payout = Math.floor(bet * 2.5)
    return { multiplier: 2.5, payout, win: true }
  }
  if (outcome === 'player-win') {
    const payout = bet * 2
    return { multiplier: 2, payout, win: true }
  }
  return { multiplier: 0, payout: 0, win: false }
}

export function formatCard(card: Card): string {
  return `${card.suit}${card.rank}`
}

export function formatHand(cards: readonly Card[]): string {
  return cards.map(formatCard).join(' / ')
}
