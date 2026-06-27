import { Extension, listener } from '@pikokr/command.ts'
import type { Message, TextChannel } from 'discord.js'
import {
  ContainerBuilder,
  TextDisplayBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
  type MessageComponentInteraction,
} from 'discord.js'
import { createEconomyService } from '../features/economy/economy'
import { formatWon } from '../config/korea'
import { logger } from '../utils/logger'

const economy = createEconomyService()
const DROP_TIMEOUT_MS = 10 * 60 * 1000
const CHECK_INTERVAL_MS = 60_000

const ACTIVE_GUILDS = new Set<string>()

type ActiveDrop = {
  dropId: string
  guildId: string
  channelId: string
  messageId: string | null
  amount: number
  maxClaims: number
  claimedBy: string[]
  amounts: Map<string, number>
  createdAt: number
  expired: boolean
}

const activeDrops = new Map<string, ActiveDrop>()

function koreanHour(): number {
  return Number(new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: 'Asia/Seoul',
  }).format(new Date()))
}

function koreanDateKey(): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Seoul',
    year: 'numeric',
  }).format(new Date())
}

class RewardExtensionClass extends Extension {
  private lastDropHour = new Map<string, number>()
  private dropsToday = new Map<string, number>()
  private lastDropDate = ''

  @listener({ event: 'messageCreate' })
  async messageCreate(message: Message) {
    if (message.author.bot) return
    if (message.guild === null) return

    ACTIVE_GUILDS.add(message.guild.id)

    try {
      await economy.recordActivity(message.author.id)
    } catch (err) {
      logger.error('Reward', `활동 보상 기록 실패: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  @listener({ event: 'clientReady' })
  async ready() {
    setInterval(() => { void this.checkRandomDrops() }, CHECK_INTERVAL_MS)
    setInterval(() => { void this.checkExpiredDrops() }, CHECK_INTERVAL_MS)
  }

  @listener({ event: 'interactionCreate' })
  async interactionCreate(interaction: MessageComponentInteraction) {
    if (!interaction.isButton()) return
    if (!interaction.customId.startsWith('drop_')) return

    const dropId = interaction.customId.slice(5)
    const drop = activeDrops.get(dropId)

    if (drop === undefined) {
      await interaction.reply({ content: '이미 만료된 보상이에요.', flags: 64 }).catch(() => {})
      return
    }

    if (drop.expired) {
      await interaction.reply({ content: '이 보상은 시간이 초과되어 소멸했어요.', flags: 64 }).catch(() => {})
      return
    }

    if (drop.claimedBy.includes(interaction.user.id)) {
      await interaction.reply({ content: '이미 수령했어요!', flags: 64 }).catch(() => {})
      return
    }

    if (drop.claimedBy.length >= drop.maxClaims) {
      await interaction.reply({ content: '선착이 마감되었어요!', flags: 64 }).catch(() => {})
      return
    }

    const amount = Math.floor(
      Math.random() * (drop.amount * 1.2 - drop.amount * 0.8 + 1)
    ) + Math.floor(drop.amount * 0.8)

    drop.claimedBy.push(interaction.user.id)
    drop.amounts.set(interaction.user.id, amount)

    try {
      await economy.addBalance(interaction.user.id, amount)
      await economy.recordDropClaim(interaction.user.id, drop.guildId, amount)
    } catch (err) {
      logger.error('Reward', `수령 실패: ${err instanceof Error ? err.message : String(err)}`)
      await interaction.reply({ content: '수령 중 오류가 발생했어요.', flags: 64 }).catch(() => {})
      return
    }

    const remaining = drop.maxClaims - drop.claimedBy.length
    const allClaimed = remaining === 0

    const container = allClaimed
      ? buildFullyClaimedContainer(drop)
      : buildActiveDropContainer(drop, remaining)

    await interaction.update({ components: [container] }).catch(() => {})

    if (allClaimed) {
      activeDrops.delete(dropId)
    }
  }

  private async checkRandomDrops(): Promise<void> {
    const today = koreanDateKey()
    if (today !== this.lastDropDate) {
      this.lastDropDate = today
      this.dropsToday.clear()
    }

    const hour = koreanHour()

    for (const guildId of ACTIVE_GUILDS) {
      const settings = await economy.getRandomDropSettings(guildId)
      if (settings === null || !settings.enabled) continue
      if (hour < settings.startHour || hour >= settings.endHour) continue

      const dropsCount = this.dropsToday.get(guildId) ?? 0
      if (dropsCount >= settings.dropsPerDay) continue

      const lastHour = this.lastDropHour.get(guildId) ?? -1
      if (lastHour === hour) continue

      const drop = await economy.createRandomDrop(guildId)
      if (drop === null) continue

      this.dropsToday.set(guildId, dropsCount + 1)
      this.lastDropHour.set(guildId, hour)

      try {
        const guild = this.client.guilds.cache.get(guildId)
        if (guild === undefined) continue

        let targetChannel: TextChannel | null = null
        if (settings.channelId !== null) {
          const ch = guild.channels.cache.get(settings.channelId)
          if (ch !== undefined && ch.isTextBased()) {
            targetChannel = ch as TextChannel
          }
        }
        if (targetChannel === null) {
          targetChannel = guild.systemChannel
        }
        if (targetChannel === null) continue

        const activeDrop: ActiveDrop = {
          dropId: drop.id,
          guildId,
          channelId: targetChannel.id,
          messageId: null,
          amount: drop.amount,
          maxClaims: settings.dropsPerDay,
          claimedBy: [],
          amounts: new Map(),
          createdAt: Date.now(),
          expired: false,
        }

        const container = buildActiveDropContainer(activeDrop, settings.dropsPerDay)
        const msg = await targetChannel.send({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        })
        activeDrop.messageId = msg.id
        activeDrops.set(drop.id, activeDrop)

        logger.info('Reward', `선착 보상 발송: ${guild.name} - ${formatWon(drop.amount)}`)
      } catch (err) {
        logger.error('Reward', `선착 보상 발송 실패: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private async checkExpiredDrops(): Promise<void> {
    const now = Date.now()

    for (const [dropId, drop] of activeDrops) {
      if (drop.expired) continue
      if (now - drop.createdAt < DROP_TIMEOUT_MS) continue
      if (drop.claimedBy.length >= drop.maxClaims) continue

      drop.expired = true

      try {
        const guild = this.client.guilds.cache.get(drop.guildId)
        if (guild === undefined) continue

        const channel = guild.channels.cache.get(drop.channelId) as TextChannel | undefined
        if (channel === undefined || drop.messageId === null) continue

        const dropsLeft = (await economy.getRandomDropSettings(drop.guildId))?.dropsPerDay ?? 4
        const remainingToday = dropsLeft - (this.dropsToday.get(drop.guildId) ?? 0)
        const allUsedToday = remainingToday <= 0

        const container = buildExpiredDropContainer(drop, allUsedToday, remainingToday)

        await channel.messages.edit(drop.messageId, {
          components: [container],
        })

        logger.info('Reward', `선착 보상 만료: ${drop.dropId} (${drop.claimedBy.length}/${drop.maxClaims}명 수령)`)
      } catch (err) {
        logger.error('Reward', `만료 처리 실패: ${err instanceof Error ? err.message : String(err)}`)
      }

      activeDrops.delete(dropId)
    }
  }
}

function buildActiveDropContainer(drop: ActiveDrop, remaining: number): ContainerBuilder {
  const claimersText = drop.claimedBy.length > 0
    ? drop.claimedBy.map((id, i) => `${i + 1}. <@${id}> - ${formatWon(drop.amounts.get(id) ?? 0)}`).join('\n')
    : '아직 수령자가 없어요!'

  const container = new ContainerBuilder()
    .setAccentColor(0xFFD700)

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🎁 선착 보상!\n\n**${formatWon(drop.amount)}** 기준!\n남은 선착: **${remaining}명**\n\n## 수령자\n${claimersText}\n-# 10분 내 수령하지 않으면 소멸해요.`
    )
  )

  const button = new ButtonBuilder()
    .setCustomId(`drop_${drop.dropId}`)
    .setLabel(remaining > 0 ? '수령하기' : '마감됨')
    .setStyle(remaining > 0 ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(remaining <= 0)

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button)
  container.addActionRowComponents(row)

  return container
}

function buildFullyClaimedContainer(drop: ActiveDrop): ContainerBuilder {
  const claimersText = drop.claimedBy
    .map((id, i) => `${i + 1}. <@${id}> - ${formatWon(drop.amounts.get(id) ?? 0)}`)
    .join('\n')

  return new ContainerBuilder()
    .setAccentColor(0x00FF00)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ✅ 선착 마감!\n\n제시간에 모든 크레딧이 수진되었어요!\n\n## 수령자\n${claimersText}\n\n-# 못 받으셨다면 다음 기회를 노려보세요!`
      )
    )
}

function buildExpiredDropContainer(drop: ActiveDrop, allUsedToday: boolean, remainingToday: number): ContainerBuilder {
  const claimersText = drop.claimedBy.length > 0
    ? drop.claimedBy.map((id, i) => `${i + 1}. <@${id}> - ${formatWon(drop.amounts.get(id) ?? 0)}`).join('\n')
    : '수령자가 없었어요.'

  const nextHint = allUsedToday
    ? '오늘은 더 이상 선착 보상이 없어요. 내일 다시 시도해보세요!'
    : `오늘 선착 보상이 ${remainingToday}회 더 남아있어요!`

  const container = new ContainerBuilder()
    .setAccentColor(0xFF4444)

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 💨 소멸됨\n\n10분이 경과하여 크레딧이 소멸했어요.\n\n## 수령자 (${drop.claimedBy.length}/${drop.maxClaims})\n${claimersText}\n\n-# ${nextHint}`
    )
  )

  const button = new ButtonBuilder()
    .setCustomId(`drop_${drop.dropId}`)
    .setLabel('소멸됨')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true)

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button)
  container.addActionRowComponents(row)

  return container
}

export const setup = async () => {
  return new RewardExtensionClass()
}
