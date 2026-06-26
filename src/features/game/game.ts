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

export function playRockPaperScissors(input: RockPaperScissorsInput): RockPaperScissorsRound {
  const botMove = pickMove(input.random)
  const result = compareMoves(input.move, botMove)
  const resultLabel =
    result === 'draw' ? '비겼어요.' : result === 'win' ? '승리했어요!' : '패배했어요.'

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
  botMove: RockPaperScissorsMove,
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
