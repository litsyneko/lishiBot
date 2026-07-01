import { formatWon } from '../config/korea'
import { createEconomyService } from '../features/economy/economy'
import type { RandomDropSettings } from '../features/economy/economy'
import { logger } from '../utils/logger'
import { Extension, listener } from '@pikokr/command.ts'
import type { Message, TextChannel } from 'discord.js'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  type MessageComponentInteraction,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js'

const economy = createEconomyService()
const DROP_TIMEOUT_MS = 10 * 60 * 1000
const CHECK_INTERVAL_MS = 60_000

const ACTIVE_GUILDS = new Set<string>()
const DROP_PROGRESS_FILLED = '🟩'
const DROP_PROGRESS_EMPTY = '⬛'

type DropTier = 'jackpot' | 'normal' | 'misery'

const TIER_JACKPOT_THRESHOLD = 0.9
const TIER_MISERY_THRESHOLD = 0.1

const JACKPOT_MESSAGES: readonly string[] = [
  '[대박사건] {user}님이 엄청난 확률을 뚫고 {amount}을(를) 획득했어요!\n부럽다... 진짜로.',
  '[대박사건] {user}님, 오늘 로또도 사세요. 진심으로.\n{amount} 획득!',
  '[대박사건] 와 이게 진짜 터지네요?\n{user}님 {amount} 획득! 오늘 뭐 드셨어요?',
  '[대박사건] {user}님이 해냈습니다...\n나머지 유저들 울고 있는 거 안 보이세요? {amount} 획득!',
  '[대박사건] 이 확률이 터지는 걸 실제로 보게 될 줄은 몰랐어요.\n{user}님 {amount} 획득. 서버 역사에 기록됩니다.',
]

const NORMAL_MESSAGES: readonly string[] = [
  '{user}님, 평균치 {amount} 획득!\n평범하지만 뭐... 없는 것보단 낫잖아요.',
  '{user}님 {amount} 획득!\n딱 평균이에요. 특별하지도 않고 슬프지도 않은 그런 결과.',
  '{user}님 {amount} 획득.\n축하는 하는데 크게 하긴 좀 애매하네요.',
  '{user}님 {amount} 획득!\n이게 평균이에요. 당신은 매우 평범합니다. (칭찬임)',
  '{user}님 {amount} 획득.\n와! ...어, 평균이네요. 그래도 받은 거잖아요 🙂',
]

const MISERY_MESSAGES: readonly string[] = [
  '[엄청난 대박사건] {user}님이 아쉽게도 {amount}을(를) 획득하셨어요.\n티끌 모아 태산이라고 하죠. 앞으로 9,900번만 더 받으시면 돼요!',
  '[엄청난 대박사건] {user}님 {amount} 획득!\n이 확률이 터질 때까지 얼마나 걸렸는지 아세요? 그게 다 의미없어졌어요.',
  '[엄청난 대박사건] 와, {user}님 대단하세요.\n이 금액을 뽑는 것도 쉬운 일이 아니거든요. {amount} 획득... 진심으로 수고하셨어요.',
  '[엄청난 대박사건] {user}님 {amount} 획득!\n서버가 당신을 응원해요. 아주 조금요.',
  '[엄청난 대박사건] {user}님이 해냈어요!!\n...{amount}을(를)요. 편의점 껌도 못 사는 금액이지만 일단 박수!',
  '[엄청난 대박사건] {user}님 {amount} 획득.\n오늘 일진이 좀 그렇죠? 내일은 나아질 거예요. (보장 못함)',
]

function pickTierMessage(
  tier: DropTier,
  userMention: string,
  amount: string
): string {
  const pool =
    tier === 'jackpot'
      ? JACKPOT_MESSAGES
      : tier === 'misery'
      ? MISERY_MESSAGES
      : NORMAL_MESSAGES
  const picked = pool[Math.floor(Math.random() * pool.length)]
  return picked.replaceAll('{user}', userMention).replaceAll('{amount}', amount)
}

function classifyTier(
  amount: number,
  minAmount: number,
  maxAmount: number
): DropTier {
  if (maxAmount <= minAmount) return 'normal'
  const ratio = (amount - minAmount) / (maxAmount - minAmount)
  if (ratio >= TIER_JACKPOT_THRESHOLD) return 'jackpot'
  if (ratio <= TIER_MISERY_THRESHOLD) return 'misery'
  return 'normal'
}

function tierAccentColor(tier: DropTier): number {
  if (tier === 'jackpot') return 0xffd700
  if (tier === 'misery') return 0x95a5a6
  return 0x3498db
}

function formatHourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

function buildScheduleSummary(scheduledHours: Set<number>): string {
  const sorted = Array.from(scheduledHours).sort((a, b) => a - b)
  const labels = sorted.map(formatHourLabel)
  return `오늘 선착보상 예정 시간\n${labels.join(' · ')}`
}

function pickDropHours(
  startHour: number,
  endHour: number,
  count: number
): Set<number> {
  const available: number[] = []
  for (let h = startHour; h < endHour; h++) {
    available.push(h)
  }
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[available[i], available[j]] = [available[j], available[i]]
  }
  const pickCount = Math.min(count, available.length)
  return new Set(available.slice(0, pickCount))
}

type ActiveDrop = {
  dropId: string
  guildId: string
  channelId: string
  messageId: string | null
  amount: number
  minAmount: number
  maxAmount: number
  maxClaims: number
  claimedBy: string[]
  amounts: Map<string, number>
  createdAt: number
  expired: boolean
  mentionRoleId: string | null
}

const activeDrops = new Map<string, ActiveDrop>()

function buildSmallDivider(): SeparatorBuilder {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Small)
}

function buildDropProgressBar(claimed: number, maxClaims: number): string {
  const safeMaxClaims = Math.max(0, maxClaims)
  const safeClaimed = Math.min(safeMaxClaims, Math.max(0, claimed))

  return `${DROP_PROGRESS_FILLED.repeat(
    safeClaimed
  )}${DROP_PROGRESS_EMPTY.repeat(safeMaxClaims - safeClaimed)}`
}

function buildClaimerLabel(index: number): string {
  if (index === 0) return '🥇'
  if (index === 1) return '🥈'
  if (index === 2) return '🥉'
  return `${index + 1}.`
}

function buildClaimersText(drop: ActiveDrop, emptyText: string): string {
  if (drop.claimedBy.length === 0) {
    return emptyText
  }

  return drop.claimedBy
    .map(
      (id, index) =>
        `${buildClaimerLabel(index)} <@${id}> · **${formatWon(
          drop.amounts.get(id) ?? 0
        )}**`
    )
    .join('\n')
}

function koreanHour(): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: 'Asia/Seoul',
    }).format(new Date())
  )
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
  private intervalHandles: ReturnType<typeof setInterval>[] = []
  private intervalsRegistered = false

  @listener({ event: 'messageCreate' })
  async messageCreate(message: Message) {
    if (message.author.bot) return
    if (message.guild === null) return

    ACTIVE_GUILDS.add(message.guild.id)

    try {
      await economy.recordActivity(message.author.id)
    } catch (err) {
      logger.error(
        'Reward',
        `활동 보상 기록 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  @listener({ event: 'clientReady' })
  async ready() {
    if (this.intervalsRegistered) return
    this.intervalsRegistered = true

    try {
      const guilds = await economy.getEnabledRandomDropGuilds()
      for (const guildId of guilds) {
        ACTIVE_GUILDS.add(guildId)
      }
      logger.info('Reward', `활성 선착보상 길드 ${guilds.length}개 로드`)
    } catch (err) {
      logger.error(
        'Reward',
        `활성 길드 로드 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }

    this.intervalHandles.push(
      setInterval(() => {
        void this.checkRandomDrops()
      }, CHECK_INTERVAL_MS)
    )
    this.intervalHandles.push(
      setInterval(() => {
        void this.checkExpiredDrops()
      }, CHECK_INTERVAL_MS)
    )
  }

  @listener({ event: 'interactionCreate' })
  async interactionCreate(interaction: MessageComponentInteraction) {
    if (!interaction.isButton()) return
    if (!interaction.customId.startsWith('drop_')) return

    const dropId = interaction.customId.slice(5)
    const drop = activeDrops.get(dropId)

    if (drop === undefined) {
      await interaction
        .reply({ content: '이미 만료된 보상이에요.', flags: 64 })
        .catch((err: unknown) => {
          logger.debug(
            'Interaction',
            `reply failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      return
    }

    if (drop.expired) {
      await interaction
        .reply({ content: '이 보상은 시간이 초과되어 소멸했어요.', flags: 64 })
        .catch((err: unknown) => {
          logger.debug(
            'Interaction',
            `reply failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      return
    }

    if (drop.claimedBy.includes(interaction.user.id)) {
      await interaction
        .reply({ content: '이미 수령했어요!', flags: 64 })
        .catch((err: unknown) => {
          logger.debug(
            'Interaction',
            `reply failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      return
    }

    if (drop.claimedBy.length >= drop.maxClaims) {
      await interaction
        .reply({ content: '선착이 마감되었어요!', flags: 64 })
        .catch((err: unknown) => {
          logger.debug(
            'Interaction',
            `reply failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      return
    }

    const amount =
      Math.floor(Math.random() * (drop.amount * 1.2 - drop.amount * 0.8 + 1)) +
      Math.floor(drop.amount * 0.8)

    drop.claimedBy.push(interaction.user.id)
    drop.amounts.set(interaction.user.id, amount)

    try {
      await economy.addBalance(interaction.user.id, amount)
      await economy.recordDropClaim(interaction.user.id, drop.guildId, amount)
      const claimOrder = await economy.claimRandomDrop(
        drop.dropId,
        interaction.user.id,
        drop.maxClaims
      )
      if (claimOrder === null) {
        logger.warn('Reward', `수령자 기록 실패: ${drop.dropId}`)
      }
    } catch (err) {
      drop.claimedBy = drop.claimedBy.filter((id) => id !== interaction.user.id)
      drop.amounts.delete(interaction.user.id)
      logger.error(
        'Reward',
        `수령 실패: ${err instanceof Error ? err.message : String(err)}`
      )
      await interaction
        .reply({ content: '수령 중 오류가 발생했어요.', flags: 64 })
        .catch((err: unknown) => {
          logger.debug(
            'Interaction',
            `reply failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      return
    }

    const remaining = drop.maxClaims - drop.claimedBy.length
    const allClaimed = remaining === 0

    const container = allClaimed
      ? buildFullyClaimedContainer(drop)
      : buildActiveDropContainer(drop, remaining)

    await interaction
      .update({ components: [container] })
      .catch((err: unknown) => {
        logger.debug(
          'Interaction',
          `update failed: ${err instanceof Error ? err.message : String(err)}`
        )
      })

    const tier = classifyTier(amount, drop.minAmount, drop.maxAmount)
    const tierMessage = pickTierMessage(
      tier,
      `<@${interaction.user.id}>`,
      formatWon(amount)
    )
    const channel = interaction.channel
    if (channel !== null && 'send' in channel) {
      await channel
        .send({
          components: [
            new ContainerBuilder()
              .setAccentColor(tierAccentColor(tier))
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(tierMessage)
              ),
          ],
          flags: MessageFlags.IsComponentsV2,
        })
        .catch((err: unknown) => {
          logger.debug(
            'Reward',
            `등급 메시지 전송 실패: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        })
    }

    if (allClaimed) {
      activeDrops.delete(dropId)
    }
  }

  private async sendAdminNotification(
    guildId: string,
    settings: RandomDropSettings,
    content: string
  ): Promise<void> {
    if (settings.adminChannelId === null) return

    const guild = this.client.guilds.cache.get(guildId)
    if (guild === undefined) return

    const channel = guild.channels.cache.get(settings.adminChannelId)
    if (channel === undefined || !channel.isTextBased()) return

    const textChannel = channel as TextChannel
    const container = new ContainerBuilder().setAccentColor(0x3498db)
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(content)
    )

    await textChannel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    })
  }

  private async checkRandomDrops(): Promise<void> {
    const today = koreanDateKey()
    const hour = koreanHour()

    for (const guildId of ACTIVE_GUILDS) {
      const settings = await economy.getRandomDropSettings(guildId)
      if (settings === null || !settings.enabled) continue

      let scheduled = await economy.getScheduledDropHours(guildId, today)

      if (scheduled.length === 0) {
        scheduled = Array.from(
          pickDropHours(
            settings.startHour,
            settings.endHour,
            settings.dropsPerDay
          )
        ).sort((a, b) => a - b)

        try {
          await economy.setScheduledDropHours(guildId, today, scheduled)

          const lastNotified = await economy.getScheduleNotifiedDate(guildId)
          if (lastNotified !== today) {
            await this.sendAdminNotification(
              guildId,
              settings,
              buildScheduleSummary(new Set(scheduled))
            )
            await economy.setScheduleNotifiedDate(guildId, today)
          }
        } catch (err) {
          logger.warn(
            'Reward',
            `스케줄 저장/알림 실패: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }

      if (hour < settings.startHour || hour >= settings.endHour) continue
      if (!scheduled.includes(hour)) continue

      const dropsCount = await economy.getRandomDropSentCount(guildId, today)
      if (dropsCount >= settings.dropsPerDay) continue

      const drop = await economy.createRandomDrop(guildId)
      if (drop === null) continue

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
          minAmount: Math.floor(drop.amount * 0.8),
          maxAmount: Math.floor(drop.amount * 1.2),
          maxClaims: settings.dropsPerDay,
          claimedBy: [],
          amounts: new Map(),
          createdAt: Date.now(),
          expired: false,
          mentionRoleId: settings.mentionRoleId,
        }

        const container = buildActiveDropContainer(
          activeDrop,
          settings.dropsPerDay
        )
        const msg = await targetChannel.send({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions:
            activeDrop.mentionRoleId !== null
              ? { roles: [activeDrop.mentionRoleId] }
              : undefined,
        })
        activeDrop.messageId = msg.id
        activeDrops.set(drop.id, activeDrop)

        const remainingHours = scheduled.filter((h) => h !== hour)
        try {
          await economy.setScheduledDropHours(guildId, today, remainingHours)
        } catch (err) {
          logger.error(
            'Reward',
            `스케줄 업데이트 실패: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }

        try {
          await economy.recordRandomDropSent(drop.id, guildId)
        } catch (err) {
          logger.error(
            'Reward',
            `선착 보상 기록 실패: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }

        logger.info(
          'Reward',
          `선착 보상 발송: ${guild.name} - ${formatWon(drop.amount)}`
        )
      } catch (err) {
        logger.error(
          'Reward',
          `선착 보상 발송 실패: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }

  private async checkExpiredDrops(): Promise<void> {
    const now = Date.now()

    for (const [dropId, drop] of Array.from(activeDrops.entries())) {
      if (drop.expired) continue
      if (now - drop.createdAt < DROP_TIMEOUT_MS) continue
      if (drop.claimedBy.length >= drop.maxClaims) continue

      drop.expired = true

      try {
        const guild = this.client.guilds.cache.get(drop.guildId)
        if (guild === undefined) continue

        const channel = guild.channels.cache.get(drop.channelId) as
          | TextChannel
          | undefined
        if (channel === undefined || drop.messageId === null) continue

        const dropsLeft =
          (await economy.getRandomDropSettings(drop.guildId))?.dropsPerDay ?? 4
        const sentToday = await economy.getRandomDropSentCount(
          drop.guildId,
          koreanDateKey()
        )
        const remainingToday = dropsLeft - sentToday
        const allUsedToday = remainingToday <= 0

        const container = buildExpiredDropContainer(
          drop,
          allUsedToday,
          remainingToday
        )

        await channel.messages.edit(drop.messageId, {
          components: [container],
        })

        logger.info(
          'Reward',
          `선착 보상 만료: ${drop.dropId} (${drop.claimedBy.length}/${drop.maxClaims}명 수령)`
        )
      } catch (err) {
        logger.error(
          'Reward',
          `만료 처리 실패: ${err instanceof Error ? err.message : String(err)}`
        )
      }

      activeDrops.delete(dropId)
    }
  }
}

function buildActiveDropContainer(
  drop: ActiveDrop,
  remaining: number
): ContainerBuilder {
  const claimedCount = drop.claimedBy.length
  const progressBar = buildDropProgressBar(claimedCount, drop.maxClaims)
  const claimersText = buildClaimersText(drop, '아직 수령자가 없어요!')

  const container = new ContainerBuilder().setAccentColor(0xffd700)

  if (drop.mentionRoleId !== null) {
    container
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`<@&${drop.mentionRoleId}>`)
      )
      .addSeparatorComponents(buildSmallDivider())
  }

  container
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# <:hi:1517560569169711297> 반가워요! 선착보상이 왔어요!\n**${drop.maxClaims}명 선착순**으로 아래 버튼을 누르면 원을 받을 수 있어요!`
      )
    )
    .addSeparatorComponents(buildSmallDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 💰 보상 정보\n**${formatWon(
          drop.amount
        )}** 기준 지급\n${progressBar} \`${claimedCount}/${
          drop.maxClaims
        }\` 수령 완료\n남은 선착: **${remaining}명**`
      )
    )
    .addSeparatorComponents(buildSmallDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🏅 현재 수령 현황\n${claimersText}`
      )
    )
    .addSeparatorComponents(buildSmallDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '-# ⏰ 10분 내 수령하지 않으면 보상이 소멸해요.'
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
  const claimedCount = drop.claimedBy.length
  const progressBar = buildDropProgressBar(claimedCount, drop.maxClaims)
  const claimersText = buildClaimersText(drop, '수령자가 없었어요.')

  return new ContainerBuilder()
    .setAccentColor(0x00ff00)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '# 🎉 선착 마감!\n## 모든 보상이 깔끔하게 소진됐어요'
      )
    )
    .addSeparatorComponents(buildSmallDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### ✨ 지급 결과\n**${formatWon(
          drop.amount
        )}** 기준 지급\n${progressBar} \`${claimedCount}/${
          drop.maxClaims
        }\` 전원 수령 완료`
      )
    )
    .addSeparatorComponents(buildSmallDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 🏆 수령자 명단\n${claimersText}`)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '-# 못 받으셨다면 다음 기회를 노려보세요!'
      )
    )
}

function buildExpiredDropContainer(
  drop: ActiveDrop,
  allUsedToday: boolean,
  remainingToday: number
): ContainerBuilder {
  const claimedCount = drop.claimedBy.length
  const progressBar = buildDropProgressBar(claimedCount, drop.maxClaims)
  const claimersText = buildClaimersText(drop, '수령자가 없었어요.')

  const nextHint = allUsedToday
    ? '오늘은 더 이상 선착 보상이 없어요. 내일 다시 시도해보세요!'
    : `오늘 선착 보상이 ${remainingToday}회 더 남아있어요!`

  const container = new ContainerBuilder().setAccentColor(0xff4444)

  container
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '# 💨 선착 보상 소멸\n## 10분이 지나 보상을 놓쳤어요'
      )
    )
    .addSeparatorComponents(buildSmallDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 📉 소멸 현황\n**${formatWon(
          drop.amount
        )}** 기준 지급\n${progressBar} \`${claimedCount}/${
          drop.maxClaims
        }\` 수령 후 종료`
      )
    )
    .addSeparatorComponents(buildSmallDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 🧾 수령 기록\n${claimersText}`)
    )
    .addSeparatorComponents(buildSmallDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 🔔 다음 기회\n${nextHint}`)
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
