import { createEconomyService } from '../features/economy/economy'
import {
  type RockPaperScissorsMove,
  flipCoin,
  playRockPaperScissors,
  rollDice,
} from '../features/game/game'
import { pickRpsMessage } from '../features/game/messages'
import { logger } from '../utils/logger'
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

const gameGroup = new SubCommandGroup({
  name: '게임',
  description: '서버에서 간단한 게임을 실행합니다.',
})
const economy = createEconomyService()
const rng = () => randomInt(0, 1000000) / 1000000

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

class GameExtensionClass extends Extension {
  @gameGroup.command({ name: '동전', description: '동전을 던집니다.' })
  async coin(i: ChatInputCommandInteraction) {
    const result = flipCoin(rng)
    const container = buildContainer([
      `# 🪙 동전 던지기`,
      `결과: **${result}**`,
    ])
    await sendContainer(i, container)
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
    sides: number
  ) {
    const result = rollDice({ random: rng, sides })
    const container = buildContainer([
      `# 🎲 주사위 (${sides}면)`,
      `결과: **${result.value}**`,
    ])
    await sendContainer(i, container)
  }

  @gameGroup.command({
    name: '가위바위보',
    description: '봇과 가위바위보를 합니다.',
  })
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
    move: RockPaperScissorsMove
  ) {
    const result = playRockPaperScissors({ move, random: rng })
    try {
      await economy.recordQuestProgress(i.user.id, 'rps')
    } catch (err) {
      logger.warn(
        'Game',
        `quest progress failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
    if (result.result === 'win') {
      try {
        await economy.addBalance(i.user.id, 2000)
      } catch (err) {
        logger.warn(
          'Game',
          `addBalance failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
    const emoji =
      result.result === 'win' ? '🎉' : result.result === 'lose' ? '💥' : '🤝'
    const tier =
      result.result === 'win'
        ? 'win'
        : result.result === 'lose'
        ? 'lose'
        : 'draw'
    const msg = pickRpsMessage(`<@${i.user.id}>`, tier)
    const label =
      result.result === 'win'
        ? '승리! +2,000원'
        : result.result === 'lose'
        ? '패배'
        : '무승부'
    const container = buildContainer(
      [
        `# ${emoji} 가위바위보`,
        `**${label}**`,
        msg,
        `-# 봇: ${result.botMove} | 사용자: ${move}`,
      ],
      result.result === 'win'
        ? 0x00ff00
        : result.result === 'lose'
        ? 0xff4444
        : 0x999999
    )
    await sendContainer(i, container)
  }
}

export const setup = async () => {
  return new GameExtensionClass()
}
