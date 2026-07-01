import { formatWon } from '../config/korea'
import { createEconomyService } from '../features/economy/economy'
import type { InventoryEntry, ShopItem } from '../features/economy/economy'
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

const shopGroup = new SubCommandGroup({
  name: '상점',
  description: '상점에서 아이템을 구매하고 사용합니다.',
})

const economy = createEconomyService()

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

async function sendContainerEphemeral(
  i: ChatInputCommandInteraction,
  container: ContainerBuilder
): Promise<void> {
  await i.reply({
    components: [container],
    flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral],
  })
}

function formatShopLine(item: ShopItem): string {
  return `${item.emoji} **${item.name}** (${item.category})\n${
    item.description
  }\n가격: ${formatWon(item.price)} | ID: \`${item.itemId}\``
}

function formatInventoryLine(
  entry: InventoryEntry,
  items: readonly ShopItem[]
): string {
  const item = items.find((it) => it.itemId === entry.itemId)
  const label = item !== undefined ? `${item.emoji} ${item.name}` : entry.itemId
  return `${label} ×${entry.quantity} (\`${entry.itemId}\`)`
}

class ShopExtensionClass extends Extension {
  @shopGroup.command({
    name: '목록',
    description: '상점에서 판매하는 아이템을 확인합니다.',
  })
  async list(i: ChatInputCommandInteraction) {
    try {
      const items = await economy.getShopItems()
      if (items.length === 0) {
        await sendContainerEphemeral(
          i,
          buildContainer(['# 🛒 상점', '현재 판매 중인 아이템이 없어요.'])
        )
        return
      }

      const blocks = [
        '# 🛒 상점 목록',
        ...items.map(formatShopLine),
        '-# 구매하려면 `/상점 구매` 명령어를 사용하세요.',
      ]
      await sendContainer(i, buildContainer(blocks, 0x3498db))
    } catch (err) {
      await sendContainerEphemeral(
        i,
        buildContainer([
          '# 🛒 상점',
          err instanceof Error
            ? err.message
            : '상점 조회 중 오류가 발생했어요.',
        ])
      )
    }
  }

  @shopGroup.command({
    name: '구매',
    description: '상점에서 아이템을 구매합니다.',
  })
  async buy(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '아이템',
      description: '구매할 아이템 ID',
      required: true,
    })
    itemId: string
  ) {
    try {
      const items = await economy.getShopItems()
      const item = items.find((it) => it.itemId === itemId)
      if (item === undefined) {
        await sendContainerEphemeral(
          i,
          buildContainer([
            '# 🛒 상점',
            '존재하지 않는 아이템이에요. `/상점 목록`으로 확인해주세요.',
          ])
        )
        return
      }

      const result = await economy.buyItem(i.user.id, itemId)
      await sendContainer(
        i,
        buildContainer(
          [
            `# 🛒 구매 완료`,
            `${item.emoji} **${item.name}**을(를) 구매했어요.\n${result.message}`,
            `남은 아이템은 \`/상점 인벤토리\`에서 확인할 수 있어요.`,
          ],
          0x2ecc71
        )
      )
    } catch (err) {
      await sendContainerEphemeral(
        i,
        buildContainer([
          '# 🛒 상점',
          err instanceof Error ? err.message : '구매 중 오류가 발생했어요.',
        ])
      )
    }
  }

  @shopGroup.command({
    name: '인벤토리',
    description: '내가 보유한 아이템을 확인합니다.',
  })
  async inventory(i: ChatInputCommandInteraction) {
    try {
      const [inventory, items] = await Promise.all([
        economy.getInventory(i.user.id),
        economy.getShopItems(),
      ])

      if (inventory.length === 0) {
        await sendContainerEphemeral(
          i,
          buildContainer([
            '# 🎒 내 인벤토리',
            '보유한 아이템이 없어요. `/상점 목록`에서 구매해보세요!',
          ])
        )
        return
      }

      const blocks = [
        '# 🎒 내 인벤토리',
        ...inventory.map((entry) => formatInventoryLine(entry, items)),
      ]
      await sendContainer(i, buildContainer(blocks, 0x9b59b6))
    } catch (err) {
      await sendContainerEphemeral(
        i,
        buildContainer([
          '# 🎒 내 인벤토리',
          err instanceof Error
            ? err.message
            : '인벤토리 조회 중 오류가 발생했어요.',
        ])
      )
    }
  }

  @shopGroup.command({
    name: '사용',
    description: '보유한 아이템을 사용합니다.',
  })
  async use(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '아이템',
      description: '사용할 아이템 ID',
      required: true,
    })
    itemId: string
  ) {
    try {
      const items = await economy.getShopItems()
      const item = items.find((it) => it.itemId === itemId)
      const nameLabel =
        item !== undefined ? `${item.emoji} ${item.name}` : itemId

      const result = await economy.useItem(i.user.id, itemId)
      await sendContainer(
        i,
        buildContainer(
          [
            `# ✨ 아이템 사용`,
            `**${nameLabel}**을(를) 사용했어요.\n${result.message}`,
          ],
          0xf1c40f
        )
      )
    } catch (err) {
      await sendContainerEphemeral(
        i,
        buildContainer([
          '# ✨ 아이템 사용',
          err instanceof Error
            ? err.message
            : '아이템 사용 중 오류가 발생했어요.',
        ])
      )
    }
  }
}

export const setup = async () => {
  return new ShopExtensionClass()
}
