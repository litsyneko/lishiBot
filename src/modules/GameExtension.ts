import { Extension, SubCommandGroup, applicationCommand, option } from '@pikokr/command.ts'
import { ApplicationCommandOptionType, ApplicationCommandType, ChatInputCommandInteraction } from 'discord.js'
import { randomInt } from 'node:crypto'
import { flipCoin, playRockPaperScissors, type RockPaperScissorsMove, rollDice } from '../features/game/game'
import { replyEphemeral } from '../utils/replies'

const gameGroup = new SubCommandGroup({ name: '게임', description: '서버에서 간단한 게임을 실행합니다.' })

class GameExtensionClass extends Extension {
  @gameGroup.command({ name: '동전', description: '동전을 던집니다.' })
  async coin(i: ChatInputCommandInteraction) {
    const result = flipCoin(() => randomInt(0, 1000) / 1000)
    await replyEphemeral(i, `동전 던지기 결과: ${result}`)
  }

  @gameGroup.command({ name: '주사위', description: '주사위를 굴립니다.' })
  async dice(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '면수',
      description: '주사위 면 수 (2 이상).',
      min_value: 2,
      required: true,
    })
    sides: number,
  ) {
    const result = rollDice({ random: () => randomInt(0, 1000) / 1000, sides })
    await replyEphemeral(i, result.label)
  }

  @gameGroup.command({ name: '가위바위보', description: '봇과 가위바위보를 합니다.' })
  async rps(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '선택',
      description: '가위, 바위, 보 중 하나를 선택하세요.',
      choices: [
        { name: '가위', value: '가위' },
        { name: '바위', value: '바위' },
        { name: '보', value: '보' },
      ],
      required: true,
    })
    move: RockPaperScissorsMove,
  ) {
    const result = playRockPaperScissors({ move, random: () => randomInt(0, 1000) / 1000 })
    await replyEphemeral(i, result.message)
  }
}

export const setup = async () => {
  return new GameExtensionClass()
}
