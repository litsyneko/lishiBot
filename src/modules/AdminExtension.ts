import { formatWon } from '../config/korea'
import { createActivityLevelService } from '../features/activityLevels/activityLevels'
import {
  deleteMessagesBulk,
  fetchRecentMessages,
} from '../features/ai/tools/helpers/messageCleanup'
import {
  disableBoostCelebration,
  enableBoostCelebration,
} from '../features/boost/boostCelebrationStore'
import { createEconomyService } from '../features/economy/economy'
import { MODERATION_CATEGORIES } from '../features/moderation/moderationConfig'
import {
  getModerationSettings,
  isModerationEnabled,
  setCategoryEnabled,
  setChannelExempt,
  setImmuneRole,
  setModerationEnabled,
  setSeverityAndTimeout,
} from '../features/moderation/moderationSettingsStore'
import {
  disableSoundboardGuard,
  enableSoundboardGuard,
  isSoundboardGuardEnabled,
} from '../features/soundboard/soundboardGuardStore'
import { logger } from '../utils/logger'
import { requireServerManager } from '../utils/permissions'
import { replyEphemeral, replyPublic } from '../utils/replies'
import {
  Extension,
  SubCommandGroup,
  listener,
  option,
} from '@pikokr/command.ts'
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  type GuildTextBasedChannel,
  type Interaction,
  MessageComponentInteraction,
  MessageFlags,
  PermissionFlagsBits,
  type User,
} from 'discord.js'

const adminGroup = new SubCommandGroup({
  name: '서버',
  description: 'LisyBot 서버 관리 명령어',
})
const economy = createEconomyService()
const activityLevels = createActivityLevelService()

const LEVEL_RESET_PREFIX = 'lvlreset:'

const LEVEL_TRACK_CHOICES = [
  { name: '텍스트', value: 'text' },
  { name: '음성', value: 'voice' },
] as const

function levelTrackLabel(track: string): string {
  if (track === 'all') return '텍스트+음성 전체'
  return track === 'voice' ? '음성' : '텍스트'
}

class AdminExtensionClass extends Extension {
  @adminGroup.command({
    name: '청소',
    description:
      '이 채널의 최근 메시지를 조건에 맞춰 대량 삭제해요. 되돌릴 수 없어요.',
  })
  async cleanChannel(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '개수',
      description: '훑어볼 최근 메시지 수 (1~1000). 조건에 맞는 것만 지워요.',
      required: true,
      min_value: 1,
      max_value: 1000,
    })
    count: number,
    @option({
      type: ApplicationCommandOptionType.User,
      name: '유저',
      description: '이 사용자가 보낸 메시지만 삭제',
      required: false,
    })
    user: User | null,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '포함단어',
      description: '이 단어가 포함된 메시지만 삭제',
      required: false,
    })
    keyword: string | null,
    @option({
      type: ApplicationCommandOptionType.Boolean,
      name: '봇만',
      description: '봇이 보낸 메시지만 삭제',
      required: false,
    })
    botsOnly: boolean | null,
    @option({
      type: ApplicationCommandOptionType.Boolean,
      name: '첨부만',
      description: '이미지·파일 첨부가 있는 메시지만 삭제',
      required: false,
    })
    attachmentsOnly: boolean | null
  ) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      await replyEphemeral(i, '이 명령어는 서버에서만 사용할 수 있어요.')
      return
    }
    const channel = i.channel
    if (channel === null || !channel.isTextBased() || channel.isDMBased()) {
      await replyEphemeral(i, '이 채널에서는 사용할 수 없어요.')
      return
    }

    await i.deferReply({ flags: MessageFlags.Ephemeral })

    const target = channel as GuildTextBasedChannel
    const fetched = await fetchRecentMessages(target, count)
    const kw = (keyword ?? '').trim().toLowerCase()
    const filtered = fetched.filter((m) => {
      if (user && m.author.id !== user.id) return false
      if (botsOnly === true && !m.author.bot) return false
      if (attachmentsOnly === true && m.attachments.size === 0) return false
      if (kw.length > 0 && !m.content.toLowerCase().includes(kw)) return false
      return true
    })

    if (filtered.length === 0) {
      await i.editReply('조건에 맞는 메시지가 없어요.')
      return
    }

    const { deleted, failed, oldCount } = await deleteMessagesBulk(
      target,
      filtered
    )

    const conds: string[] = []
    if (user) conds.push(`유저 <@${user.id}>`)
    if (botsOnly === true) conds.push('봇만')
    if (attachmentsOnly === true) conds.push('첨부만')
    if (kw.length > 0) conds.push(`"${(keyword ?? '').trim()}" 포함`)
    const condLabel = conds.length > 0 ? ` (조건: ${conds.join(', ')})` : ''

    const parts = [`🧹 메시지 ${deleted}개를 청소했어요${condLabel}.`]
    if (oldCount > 0) {
      parts.push(`14일 초과 ${oldCount}개는 하나씩 지웠어요.`)
    }
    if (failed > 0) parts.push(`${failed}개는 삭제하지 못했어요.`)
    await i.editReply(parts.join(' '))
  }

  @adminGroup.command({
    name: '사운드보드',
    description: '사운드보드 스팸 방지 기능을 켜거나 끕니다.',
  })
  async toggleSoundboardGuard(i: ChatInputCommandInteraction) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      return
    }

    if (isSoundboardGuardEnabled(guild.id)) {
      await disableSoundboardGuard(guild.id)
      await replyPublic(i, '🔇 사운드보드 스팸 방지를 **해제**했어요.')
    } else {
      await enableSoundboardGuard(guild.id)
      await replyPublic(
        i,
        '🔊 사운드보드 스팸 방지를 **활성화**했어요.\n10초 내 15회 초과 사용 시 30초 음소거됩니다.'
      )
    }
  }

  @adminGroup.command({
    name: '검열',
    description: '욕설·스팸·홍보·개인정보 자동 검열 기능을 켜거나 끕니다.',
  })
  async toggleModeration(i: ChatInputCommandInteraction) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      return
    }

    const currentlyEnabled = isModerationEnabled(guild.id)
    await setModerationEnabled(guild.id, !currentlyEnabled)

    if (currentlyEnabled) {
      await replyPublic(i, '🛡️ 자동 검열을 **해제**했어요.')
    } else {
      await replyPublic(
        i,
        '🛡️ 자동 검열을 **활성화**했어요.\n욕설·스팸·홍보·개인정보 등을 자동으로 감지해 삭제합니다. (메시지 관리 권한 보유자는 면제)'
      )
    }
  }

  @adminGroup.command({
    name: '검열현황',
    description: '현재 검열 설정을 확인합니다.',
  })
  async moderationStatus(i: ChatInputCommandInteraction) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      return
    }

    const settings = getModerationSettings(guild.id)
    const disabled = new Set(settings.disabled_categories)
    const categoryLine = MODERATION_CATEGORIES.map(
      (c) => `${disabled.has(c.key) ? '⬜' : '✅'} ${c.label}`
    ).join(' · ')
    const severityLabel =
      settings.min_severity === 'high'
        ? '높음만'
        : settings.min_severity === 'medium'
        ? '중간 이상'
        : '낮음(전체)'
    const channelLine =
      settings.exempt_channels.length > 0
        ? settings.exempt_channels.map((id) => `<#${id}>`).join(', ')
        : '없음'
    const roleLine =
      settings.immune_roles.length > 0
        ? settings.immune_roles.map((id) => `<@&${id}>`).join(', ')
        : '기본값'

    await replyPublic(
      i,
      [
        '🛡️ **검열 현황**',
        `- 상태: ${settings.enabled ? '🟢 켜짐' : '🔴 꺼짐'}`,
        `- 카테고리: ${categoryLine}`,
        `- 최소 심각도: ${severityLabel} · 타임아웃 ${
          settings.timeout_enabled ? '적용' : '미적용'
        }`,
        `- 제외 채널: ${channelLine}`,
        `- 면제 역할: ${roleLine}`,
      ].join('\n')
    )
  }

  @adminGroup.command({
    name: '검열카테고리',
    description: '검열 카테고리(욕설/정치/NSFW 등)를 개별로 켜거나 끕니다.',
  })
  async setModerationCategory(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '카테고리',
      description: '설정할 검열 카테고리',
      required: true,
      choices: MODERATION_CATEGORIES.map((c) => ({
        name: c.label,
        value: c.key,
      })),
    })
    categoryKey: string,
    @option({
      type: ApplicationCommandOptionType.Boolean,
      name: '활성화',
      description: 'true면 켜기, false면 끄기',
      required: true,
    })
    enabled: boolean
  ) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      return
    }

    const category = MODERATION_CATEGORIES.find((c) => c.key === categoryKey)
    if (category === undefined) {
      await replyPublic(i, '알 수 없는 카테고리예요.')
      return
    }

    await setCategoryEnabled(guild.id, category.key, enabled)
    await replyPublic(
      i,
      `🛡️ **${category.label}** 검열을 ${
        enabled ? '**켰어요**' : '**껐어요**'
      }.`
    )
  }

  @adminGroup.command({
    name: '검열채널',
    description: '특정 채널을 검열에서 제외하거나 다시 포함합니다.',
  })
  async setModerationChannel(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Channel,
      name: '채널',
      description: '설정할 채널',
      required: true,
    })
    _channel: unknown,
    @option({
      type: ApplicationCommandOptionType.Boolean,
      name: '제외',
      description: 'true면 검열 제외, false면 다시 검열 대상',
      required: true,
    })
    exempt: boolean
  ) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      return
    }

    const channel = i.options.getChannel('채널', true)
    await setChannelExempt(guild.id, channel.id, exempt)
    await replyPublic(
      i,
      `🛡️ <#${channel.id}> 채널을 검열 ${
        exempt ? '**제외**했어요' : '대상에 **다시 포함**했어요'
      }.`
    )
  }

  @adminGroup.command({
    name: '검열역할',
    description: '검열 면제 역할을 추가하거나 제거합니다.',
  })
  async setModerationRole(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Role,
      name: '역할',
      description: '설정할 역할',
      required: true,
    })
    _role: unknown,
    @option({
      type: ApplicationCommandOptionType.Boolean,
      name: '면제',
      description: 'true면 면제 추가, false면 면제 제거',
      required: true,
    })
    immune: boolean
  ) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      return
    }

    const role = i.options.getRole('역할', true)
    await setImmuneRole(guild.id, role.id, immune)
    await replyPublic(
      i,
      `🛡️ <@&${role.id}> 역할을 검열 면제에서 ${
        immune ? '**추가**했어요' : '**제거**했어요'
      }.`
    )
  }

  @adminGroup.command({
    name: '검열강도',
    description: '조치할 최소 심각도와 타임아웃 적용 여부를 설정합니다.',
  })
  async setModerationSeverity(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '최소심각도',
      description: '이 심각도 이상만 조치',
      required: true,
      choices: [
        { name: '낮음 (전체 조치)', value: 'low' },
        { name: '중간 이상', value: 'medium' },
        { name: '높음만', value: 'high' },
      ],
    })
    minSeverity: string,
    @option({
      type: ApplicationCommandOptionType.Boolean,
      name: '타임아웃',
      description: 'true면 타임아웃 적용, false면 삭제만',
      required: true,
    })
    timeoutEnabled: boolean
  ) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      return
    }

    const severity =
      minSeverity === 'high' || minSeverity === 'medium' ? minSeverity : 'low'
    await setSeverityAndTimeout(guild.id, severity, timeoutEnabled)

    const severityLabel =
      severity === 'high'
        ? '높음만'
        : severity === 'medium'
        ? '중간 이상'
        : '낮음(전체)'
    await replyPublic(
      i,
      `🛡️ 검열 강도를 **${severityLabel}**, 타임아웃 **${
        timeoutEnabled ? '적용' : '미적용'
      }**으로 설정했어요.`
    )
  }

  @adminGroup.command({
    name: '부스트축하',
    description:
      '서버 부스트 축하 메시지 자동 전송을 켜거나 끕니다. (시스템 채널로 전송)',
  })
  async toggleBoostCelebration(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Boolean,
      name: '활성화',
      description: 'true면 켜기, false면 끄기',
      required: true,
    })
    enabled: boolean
  ) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      return
    }

    if (enabled) {
      await enableBoostCelebration(guild.id)
      const channelLabel = guild.systemChannelId
        ? `<#${guild.systemChannelId}>`
        : '미설정 (시스템 채널 필요)'
      await replyPublic(
        i,
        `💜 서버 부스트 축하 메시지를 **활성화**했어요.\n전송 채널: ${channelLabel}\n멤버가 서버를 부스트하면 자동으로 축하 임베드가 전송돼요.`
      )
    } else {
      await disableBoostCelebration(guild.id)
      await replyPublic(i, '💜 서버 부스트 축하 메시지를 **해제**했어요.')
    }
  }

  @adminGroup.command({
    name: '지급',
    description: '관리자: 유저에게 원을 지급합니다.',
  })
  async grantBalance(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.User,
      name: '대상',
      description: '지급받을 유저',
      required: true,
    })
    _target: unknown,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '금액',
      description: '지급 금액 (원)',
      min_value: 1,
      required: true,
    })
    amount: number,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '사유',
      description: '지급 사유 (선택)',
      required: false,
    })
    reason: string | null
  ) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      await replyEphemeral(i, '이 명령어는 서버에서만 사용할 수 있어요.')
      return
    }

    const target = i.options.getUser('대상', true)
    if (target.bot) {
      await replyEphemeral(i, '봇에게는 지급할 수 없어요.')
      return
    }

    const result = await economy.addBalance(guild.id, target.id, amount)
    await replyPublic(
      i,
      `💸 <@${target.id}>님에게 **${formatWon(
        amount
      )}**을(를) 지급했어요.\n사유: ${
        reason ?? '미기재'
      }\n-# 지급 후 잔액: ${formatWon(result.amount)}`
    )
  }

  @adminGroup.command({
    name: '회수',
    description: '관리자: 유저의 원을 회수합니다. (잔액 부족 시 전액 회수)',
  })
  async revokeBalance(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.User,
      name: '대상',
      description: '회수할 유저',
      required: true,
    })
    _target: unknown,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '금액',
      description: '회수 금액 (원)',
      min_value: 1,
      required: true,
    })
    amount: number,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '사유',
      description: '회수 사유 (선택)',
      required: false,
    })
    reason: string | null
  ) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      await replyEphemeral(i, '이 명령어는 서버에서만 사용할 수 있어요.')
      return
    }

    const target = i.options.getUser('대상', true)
    if (target.bot) {
      await replyEphemeral(i, '봇에게서는 회수할 수 없어요.')
      return
    }

    const result = await economy.subtractBalance(guild.id, target.id, amount)
    const shortfallNote =
      result.subtracted < amount
        ? `\n-# 잔액이 부족해 요청한 ${formatWon(
            amount
          )} 중 있는 만큼만 회수했어요.`
        : ''
    await replyPublic(
      i,
      `🧾 <@${target.id}>님에게서 **${formatWon(
        result.subtracted
      )}**을(를) 회수했어요.${shortfallNote}\n사유: ${
        reason ?? '미기재'
      }\n-# 회수 후 잔액: ${formatWon(result.newBalance)}`
    )
  }

  @adminGroup.command({
    name: '레벨조정',
    description:
      '관리자: 유저의 서버 활동 XP를 조정합니다. (음수 입력 시 차감)',
  })
  async adjustLevelXp(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.User,
      name: '대상',
      description: '조정할 유저',
      required: true,
    })
    _target: unknown,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '트랙',
      description: '조정할 레벨 트랙',
      required: true,
      choices: [...LEVEL_TRACK_CHOICES],
    })
    track: string,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: 'xp',
      description: '조정할 XP (양수 = 지급, 음수 = 차감)',
      required: true,
    })
    xpDelta: number
  ) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) return

    const target = i.options.getUser('대상', true)
    if (target.bot) {
      await replyEphemeral(i, '봇의 레벨은 조정할 수 없어요.')
      return
    }
    if (xpDelta === 0) {
      await replyEphemeral(
        i,
        '0은 조정할 수 없어요. 양수(지급) 또는 음수(차감)를 입력해 주세요.'
      )
      return
    }

    const resolvedTrack = track === 'voice' ? 'voice' : 'text'
    const stats = await activityLevels.adjustXp(
      guild.id,
      target.id,
      resolvedTrack,
      xpDelta
    )
    const sign = xpDelta > 0 ? '+' : ''
    await replyPublic(
      i,
      `📊 <@${target.id}>님의 ${levelTrackLabel(
        resolvedTrack
      )} XP를 **${sign}${xpDelta.toLocaleString(
        'ko-KR'
      )}** 조정했어요.\n-# 현재: 레벨 ${
        stats.level
      } · 누적 XP ${stats.xp.toLocaleString('ko-KR')}`
    )
  }

  @adminGroup.command({
    name: '레벨초기화',
    description: '관리자: 유저의 서버 활동 레벨 기록을 초기화합니다.',
  })
  async resetLevelRecords(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.User,
      name: '대상',
      description: '초기화할 유저',
      required: true,
    })
    _target: unknown,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '트랙',
      description: '초기화할 레벨 트랙',
      required: true,
      choices: [...LEVEL_TRACK_CHOICES, { name: '전체', value: 'all' }],
    })
    track: string
  ) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) return

    const target = i.options.getUser('대상', true)
    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${LEVEL_RESET_PREFIX}${target.id}:${track}`)
        .setLabel('초기화 실행')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${LEVEL_RESET_PREFIX}cancel`)
        .setLabel('취소')
        .setStyle(ButtonStyle.Secondary)
    )

    await i.reply({
      components: [confirmRow],
      content: `⚠️ <@${target.id}>님의 **${levelTrackLabel(
        track
      )}** 레벨 기록을 초기화할까요?\n레벨·XP·활동 횟수가 모두 삭제되며 되돌릴 수 없어요.`,
      flags: MessageFlags.Ephemeral,
    })
  }

  @listener({ event: 'interactionCreate' })
  async onAdminInteraction(interaction: Interaction) {
    try {
      if (
        interaction.isButton() &&
        interaction.customId.startsWith(LEVEL_RESET_PREFIX)
      ) {
        await this.handleLevelReset(interaction)
      }
    } catch (err) {
      logger.warn(
        'Admin',
        `관리 패널 상호작용 오류: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  private async handleLevelReset(interaction: ButtonInteraction) {
    if (interaction.guild === null) return

    if (!canManageLevels(interaction)) {
      await interaction.reply({
        content: '서버 관리 권한이 있는 사용자만 실행할 수 있어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const payload = interaction.customId.slice(LEVEL_RESET_PREFIX.length)
    if (payload === 'cancel') {
      await interaction.update({
        components: [],
        content: '레벨 초기화를 취소했어요.',
      })
      return
    }

    const [targetId, track] = payload.split(':')
    if (
      targetId === undefined ||
      (track !== 'text' && track !== 'voice' && track !== 'all')
    ) {
      return
    }

    await activityLevels.resetLevels(interaction.guild.id, targetId, track)

    const label = levelTrackLabel(track)
    await interaction.update({
      components: [],
      content: `🧹 <@${targetId}>님의 **${label}** 레벨 기록을 초기화했어요.`,
    })

    // 파괴적 조치는 채널에도 공개해 투명하게 남긴다.
    const channel = interaction.channel
    if (channel !== null && 'send' in channel) {
      await channel
        .send({
          allowedMentions: { parse: [] },
          content: `🧹 <@${targetId}>님의 ${label} 레벨 기록이 관리자에 의해 초기화되었어요.`,
        })
        .catch((err: unknown) => {
          logger.debug(
            'Admin',
            `레벨 초기화 공지 실패: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        })
    }
  }
}

function canManageLevels(interaction: MessageComponentInteraction): boolean {
  const permissions = interaction.memberPermissions
  if (permissions === null) return false
  return (
    permissions.has(PermissionFlagsBits.Administrator) ||
    permissions.has(PermissionFlagsBits.ManageGuild)
  )
}

export const setup = async () => {
  return new AdminExtensionClass()
}
