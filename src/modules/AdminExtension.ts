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
import type {
  RandomDropSettings,
  ShopEffectType,
  ShopItemInput,
} from '../features/economy/economy'
import {
  AMOUNT_MODAL_ID,
  DEFAULT_RANDOM_DROP_SETTINGS,
  RANDOM_DROP_COMPONENT_PREFIX,
  SCHEDULE_MODAL_ID,
  buildAmountModal,
  buildCancelledRandomDropPanel,
  buildExpiredRandomDropPanel,
  buildRandomDropPanel,
  buildSavedRandomDropPanel,
  buildScheduleModal,
} from '../features/economy/randomDropPanel'
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
  type Message,
  MessageComponentInteraction,
  MessageFlags,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  type User,
} from 'discord.js'

const adminGroup = new SubCommandGroup({
  name: '서버',
  description: 'FullMoon 서버 관리 명령어',
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

// ── 관리자 상점 편집용 효과 유형 ──
const SHOP_EFFECT_CHOICES = [
  { name: '현금 지급', value: 'cash' },
  { name: '미스터리 상자', value: 'mystery_box' },
  { name: '도박 운 부스트', value: 'luck_boost' },
  { name: '경험치 2배', value: 'double_xp' },
  { name: '역할 지급', value: 'role' },
  { name: '수집품(효과 없음)', value: 'collectible' },
] as const

const SHOP_EFFECT_LABELS: Record<ShopEffectType, string> = {
  cash: '현금 지급',
  mystery_box: '미스터리 상자',
  luck_boost: '도박 운 부스트',
  double_xp: '경험치 2배',
  role: '역할 지급',
  collectible: '수집품',
}

const SHOP_DEFAULT_EMOJI: Record<ShopEffectType, string> = {
  cash: '💰',
  mystery_box: '🎁',
  luck_boost: '🍀',
  double_xp: '⚡',
  role: '🎭',
  collectible: '📦',
}

// 효과 유형별로 관리자가 입력한 값(값/최대값/역할)을 검증하고 저장 형태로 변환한다.
// 문제가 있으면 에러 메시지를 반환한다.
type ShopBuildResult =
  | { ok: true; item: ShopItemInput }
  | { ok: false; error: string }

function buildShopItemInput(params: {
  itemId: string
  name: string
  price: number
  effectType: ShopEffectType
  value: number | undefined
  maxValue: number | undefined
  roleId: string | null
  description: string | undefined
  emoji: string | undefined
  category: string | undefined
}): ShopBuildResult {
  const {
    itemId,
    name,
    price,
    effectType,
    value,
    maxValue,
    roleId,
    description,
    emoji,
    category,
  } = params

  let effectValue: number | null = null
  let effectMax: number | null = null
  let finalRoleId: string | null = null
  let autoDescription = ''

  if (effectType === 'cash') {
    if (value === undefined || value <= 0) {
      return {
        ok: false,
        error: '현금 지급은 `값`(지급액)을 1 이상 입력해야 해요.',
      }
    }
    effectValue = value
    autoDescription = `사용 시 ${formatWon(value)}을(를) 지급받아요.`
  } else if (effectType === 'mystery_box') {
    const min = value ?? 5000
    const max = maxValue ?? 100000
    if (min <= 0 || max < min) {
      return {
        ok: false,
        error:
          '미스터리 상자는 `값`(최소)과 `최대값`(최대)을 확인해 주세요. 최대는 최소 이상이어야 해요.',
      }
    }
    effectValue = min
    effectMax = max
    autoDescription = `열면 ${formatWon(min)}~${formatWon(
      max
    )} 중 무작위 보상을 받아요.`
  } else if (effectType === 'luck_boost') {
    const charges = value ?? 1
    if (charges <= 0) {
      return {
        ok: false,
        error: '도박 운 부스트는 `값`(횟수)을 1 이상 입력해야 해요.',
      }
    }
    effectValue = charges
    autoDescription = `사용 시 다음 도박 ${charges}회에서 이기면 상금이 10% 증가해요.`
  } else if (effectType === 'double_xp') {
    const minutes = value ?? 30
    if (minutes <= 0) {
      return {
        ok: false,
        error: '경험치 2배는 `값`(분)을 1 이상 입력해야 해요.',
      }
    }
    effectValue = minutes
    autoDescription = `사용 후 ${minutes}분간 서버 활동(채팅) 경험치가 2배로 적립돼요.`
  } else if (effectType === 'role') {
    if (roleId === null) {
      return { ok: false, error: '역할 지급은 `역할` 옵션을 지정해야 해요.' }
    }
    finalRoleId = roleId
    autoDescription = `사용 시 <@&${roleId}> 역할을 지급받아요.`
  } else {
    autoDescription = '수집용 아이템이에요.'
  }

  return {
    ok: true,
    item: {
      itemId,
      name,
      description: description ?? autoDescription,
      price,
      category: category ?? SHOP_EFFECT_LABELS[effectType],
      emoji: emoji ?? SHOP_DEFAULT_EMOJI[effectType],
      effectType,
      effectValue,
      effectMax,
      roleId: finalRoleId,
    },
  }
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

  @adminGroup.command({
    name: '선착보상',
    description: '선착보상 설정 패널을 엽니다. (금액·시간·횟수·채널·역할)',
  })
  async openRandomDropPanel(i: ChatInputCommandInteraction) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      return
    }

    const stored = await economy.getRandomDropSettings(guild.id)
    const settings = stored ?? DEFAULT_RANDOM_DROP_SETTINGS
    registerDropSession(guild.id, settings, i)
    await i.reply(buildRandomDropPanel(settings, false))
  }

  @adminGroup.command({
    name: '상점추가',
    description: '상점 아이템을 추가하거나, 같은 ID면 내용을 수정합니다.',
  })
  async shopAdd(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '아이디',
      description: '아이템 고유 ID (영문/숫자 권장)',
      required: true,
    })
    itemId: string,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '이름',
      description: '상점에 표시될 이름',
      required: true,
    })
    name: string,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '가격',
      description: '구매 가격 (원)',
      min_value: 0,
      required: true,
    })
    price: number,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '효과',
      description: '아이템 효과 유형',
      required: true,
      choices: [...SHOP_EFFECT_CHOICES],
    })
    effect: string,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '값',
      description: '현금액 / 미스터리 최소 / 부스트 횟수 / 경험치 분',
      min_value: 1,
      required: false,
    })
    value: number,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '최대값',
      description: '미스터리 상자 최대 지급액',
      min_value: 1,
      required: false,
    })
    maxValue: number,
    @option({
      type: ApplicationCommandOptionType.Role,
      name: '역할',
      description: '역할 지급 효과일 때 부여할 역할',
      required: false,
    })
    _role: unknown,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '설명',
      description: '상점에 표시될 설명 (미입력 시 자동 생성)',
      required: false,
    })
    description: string,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '이모지',
      description: '아이템 이모지 (미입력 시 효과별 기본값)',
      required: false,
    })
    emoji: string,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '분류',
      description: '아이템 분류 (미입력 시 효과 이름)',
      required: false,
    })
    category: string
  ) {
    requireServerManager(i)
    const guild = i.guild
    if (guild === null) {
      await replyEphemeral(i, '이 명령어는 서버에서만 사용할 수 있어요.')
      return
    }

    const roleId = i.options.getRole('역할')?.id ?? null
    const built = buildShopItemInput({
      itemId: itemId.trim(),
      name: name.trim(),
      price,
      effectType: effect as ShopEffectType,
      value: value ?? undefined,
      maxValue: maxValue ?? undefined,
      roleId,
      description: description?.trim() ? description.trim() : undefined,
      emoji: emoji?.trim() ? emoji.trim() : undefined,
      category: category?.trim() ? category.trim() : undefined,
    })

    if (!built.ok) {
      await replyEphemeral(i, `⚠️ ${built.error}`)
      return
    }

    try {
      await economy.upsertShopItem(guild.id, built.item)
      await replyPublic(
        i,
        `🛒 상점 아이템 **${built.item.emoji} ${built.item.name}** (\`${
          built.item.itemId
        }\`)을(를) 저장했어요.\n- 가격: ${formatWon(
          built.item.price
        )}\n- 효과: ${SHOP_EFFECT_LABELS[built.item.effectType]}\n- 설명: ${
          built.item.description
        }`
      )
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error
          ? err.message
          : '상점 아이템 저장 중 오류가 발생했어요.'
      )
    }
  }

  @adminGroup.command({
    name: '상점삭제',
    description: '상점 아이템을 삭제합니다.',
  })
  async shopDelete(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '아이디',
      description: '삭제할 아이템 ID',
      required: true,
    })
    itemId: string
  ) {
    requireServerManager(i)
    const guild = i.guild
    if (guild === null) {
      await replyEphemeral(i, '이 명령어는 서버에서만 사용할 수 있어요.')
      return
    }

    try {
      const removed = await economy.deleteShopItem(guild.id, itemId.trim())
      if (removed) {
        await replyPublic(
          i,
          `🗑️ 상점 아이템 \`${itemId.trim()}\`을(를) 삭제했어요.`
        )
      } else {
        await replyEphemeral(
          i,
          `\`${itemId.trim()}\` 아이템을 찾지 못했어요. \`/서버 상점목록\`으로 확인해 주세요.`
        )
      }
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error
          ? err.message
          : '상점 아이템 삭제 중 오류가 발생했어요.'
      )
    }
  }

  @adminGroup.command({
    name: '상점목록',
    description: '이 서버 상점의 아이템과 효과 설정을 확인합니다.',
  })
  async shopList(i: ChatInputCommandInteraction) {
    requireServerManager(i)
    const guild = i.guild
    if (guild === null) {
      await replyEphemeral(i, '이 명령어는 서버에서만 사용할 수 있어요.')
      return
    }

    try {
      const items = await economy.getShopItems(guild.id)
      if (items.length === 0) {
        await replyEphemeral(
          i,
          '이 서버 상점에 아이템이 없어요. `/서버 상점추가` 또는 `/서버 상점기본`으로 추가하세요.'
        )
        return
      }

      const lines = items.map((it) => {
        const params =
          it.effectType === 'mystery_box'
            ? ` (${formatWon(it.effectValue ?? 0)}~${formatWon(
                it.effectMax ?? 0
              )})`
            : it.effectType === 'cash'
            ? ` (${formatWon(it.effectValue ?? 0)})`
            : it.effectType === 'double_xp'
            ? ` (${it.effectValue ?? 0}분)`
            : it.effectType === 'luck_boost'
            ? ` (${it.effectValue ?? 0}회)`
            : it.effectType === 'role' && it.roleId !== null
            ? ` (<@&${it.roleId}>)`
            : ''
        return `${it.emoji} **${it.name}** \`${it.itemId}\` — ${formatWon(
          it.price
        )} · ${SHOP_EFFECT_LABELS[it.effectType]}${params}`
      })

      await replyEphemeral(
        i,
        `🛒 **상점 아이템 (${items.length})**\n\n${lines.join('\n')}`
      )
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error
          ? err.message
          : '상점 목록 조회 중 오류가 발생했어요.'
      )
    }
  }

  @adminGroup.command({
    name: '상점기본',
    description:
      '기본 아이템 3종(운 부스트/경험치 2배/미스터리 상자)을 이 서버에 추가합니다.',
  })
  async shopSeedDefaults(i: ChatInputCommandInteraction) {
    requireServerManager(i)
    const guild = i.guild
    if (guild === null) {
      await replyEphemeral(i, '이 명령어는 서버에서만 사용할 수 있어요.')
      return
    }

    const defaults: ShopItemInput[] = [
      {
        itemId: 'mystery_box',
        name: '미스터리 상자',
        description: '열면 5,000원~100,000원 중 무작위 보상을 즉시 지급받아요.',
        price: 20000,
        category: '상자',
        emoji: '🎁',
        effectType: 'mystery_box',
        effectValue: 5000,
        effectMax: 100000,
        roleId: null,
      },
      {
        itemId: 'double_xp',
        name: '경험치 2배',
        description: '사용 후 30분간 서버 활동(채팅) 경험치가 2배로 적립돼요.',
        price: 30000,
        category: '부스트',
        emoji: '⚡',
        effectType: 'double_xp',
        effectValue: 30,
        effectMax: null,
        roleId: null,
      },
      {
        itemId: 'luck_boost',
        name: '도박 운 부스트',
        description: '다음 도박 1회에서 이기면 상금이 10% 증가해요.',
        price: 50000,
        category: '부스트',
        emoji: '🍀',
        effectType: 'luck_boost',
        effectValue: 1,
        effectMax: null,
        roleId: null,
      },
    ]

    try {
      for (const item of defaults) {
        await economy.upsertShopItem(guild.id, item)
      }
      await replyPublic(
        i,
        '🛒 기본 아이템 3종(🎁 미스터리 상자 · ⚡ 경험치 2배 · 🍀 도박 운 부스트)을 상점에 추가했어요.'
      )
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error
          ? err.message
          : '기본 아이템 추가 중 오류가 발생했어요.'
      )
    }
  }

  @listener({ event: 'interactionCreate' })
  async onAdminInteraction(interaction: Interaction) {
    try {
      if (
        interaction.isMessageComponent() &&
        interaction.customId.startsWith(RANDOM_DROP_COMPONENT_PREFIX)
      ) {
        await this.handleDropComponent(interaction)
        return
      }
      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(RANDOM_DROP_COMPONENT_PREFIX)
      ) {
        await this.handleDropModal(interaction)
        return
      }
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

    if (!canManageDropPanel(interaction)) {
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

  private async handleDropComponent(interaction: MessageComponentInteraction) {
    if (interaction.guild === null) return

    if (!canManageDropPanel(interaction)) {
      await interaction.reply({
        content: '서버 관리 권한이 있는 사용자만 설정을 바꿀 수 있어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const guildId = interaction.guild.id
    const action = interaction.customId.slice(
      RANDOM_DROP_COMPONENT_PREFIX.length
    )
    const session = await ensureDropSession(guildId, interaction)

    if (action === 'amount') {
      touchDropSession(guildId, interaction)
      await interaction.showModal(buildAmountModal(session.draft))
      return
    }

    if (action === 'schedule') {
      touchDropSession(guildId, interaction)
      await interaction.showModal(buildScheduleModal(session.draft))
      return
    }

    if (action === 'save') {
      await economy.setRandomDropSettings(guildId, session.draft)
      clearDropSession(guildId)
      await interaction.update(buildSavedRandomDropPanel(session.draft))
      return
    }

    if (action === 'cancel') {
      clearDropSession(guildId)
      await interaction.update(buildCancelledRandomDropPanel())
      return
    }

    if (action === 'toggle') {
      session.draft = { ...session.draft, enabled: !session.draft.enabled }
      session.dirty = true
    } else if (action === 'channel' && interaction.isChannelSelectMenu()) {
      session.draft = {
        ...session.draft,
        channelId: interaction.values[0] ?? null,
      }
      session.dirty = true
    } else if (action === 'adminchannel' && interaction.isChannelSelectMenu()) {
      session.draft = {
        ...session.draft,
        adminChannelId: interaction.values[0] ?? null,
      }
      session.dirty = true
    } else if (action === 'role' && interaction.isRoleSelectMenu()) {
      session.draft = {
        ...session.draft,
        mentionRoleId: interaction.values[0] ?? null,
      }
      session.dirty = true
    }

    touchDropSession(guildId, interaction)
    await interaction.update(buildRandomDropPanel(session.draft, session.dirty))
  }

  private async handleDropModal(interaction: ModalSubmitInteraction) {
    if (interaction.guild === null) return

    const guildId = interaction.guild.id
    const session = await ensureDropSession(guildId, interaction)

    if (interaction.customId === AMOUNT_MODAL_ID) {
      const min = parsePositiveInt(interaction.fields.getTextInputValue('min'))
      const max = parsePositiveInt(interaction.fields.getTextInputValue('max'))

      if (min === null || max === null || min < 1 || max < min) {
        await interaction.reply({
          content:
            '⚠️ 금액을 다시 확인해 주세요. 최소 금액은 1원 이상, 최대 금액은 최소 금액 이상이어야 해요.',
          flags: MessageFlags.Ephemeral,
        })
        return
      }

      session.draft = { ...session.draft, maxAmount: max, minAmount: min }
    } else if (interaction.customId === SCHEDULE_MODAL_ID) {
      const start = parsePositiveInt(
        interaction.fields.getTextInputValue('start')
      )
      const end = parsePositiveInt(interaction.fields.getTextInputValue('end'))
      const count = parsePositiveInt(
        interaction.fields.getTextInputValue('count')
      )

      const valid =
        start !== null &&
        end !== null &&
        count !== null &&
        start >= 0 &&
        start <= 23 &&
        end >= 1 &&
        end <= 24 &&
        start < end &&
        count >= 1 &&
        count <= 10

      if (!valid) {
        await interaction.reply({
          content:
            '⚠️ 시간·횟수를 다시 확인해 주세요. 시작(0~23)은 종료(1~24)보다 앞서야 하고, 횟수는 1~10회여야 해요.',
          flags: MessageFlags.Ephemeral,
        })
        return
      }

      session.draft = {
        ...session.draft,
        dropsPerDay: count,
        endHour: end,
        startHour: start,
      }
    } else {
      return
    }

    session.dirty = true
    touchDropSession(guildId, interaction)

    if (interaction.isFromMessage()) {
      await interaction.update(buildRandomDropPanel(session.draft, true))
    }
  }
}

// ── 선착보상 설정 패널 세션 (길드별 드래프트 + 3분 자동 저장) ──

type DropPanelSource =
  | ChatInputCommandInteraction
  | MessageComponentInteraction
  | ModalSubmitInteraction

type DropPanelSession = {
  draft: RandomDropSettings
  dirty: boolean
  timeoutHandle: ReturnType<typeof setTimeout>
  source: DropPanelSource
}

const DROP_PANEL_TIMEOUT_MS = 3 * 60 * 1000
const dropPanelSessions = new Map<string, DropPanelSession>()

function registerDropSession(
  guildId: string,
  draft: RandomDropSettings,
  source: DropPanelSource
): DropPanelSession {
  clearDropSession(guildId)

  const session: DropPanelSession = {
    dirty: false,
    draft,
    source,
    timeoutHandle: setTimeout(
      () => void expireDropSession(guildId),
      DROP_PANEL_TIMEOUT_MS
    ),
  }
  dropPanelSessions.set(guildId, session)
  return session
}

// 세션이 사라진 뒤(재시작 등) 남은 패널 조작도 이어서 처리할 수 있게
// DB에서 현재 설정을 다시 불러와 세션을 복구한다.
async function ensureDropSession(
  guildId: string,
  source: DropPanelSource
): Promise<DropPanelSession> {
  const existing = dropPanelSessions.get(guildId)
  if (existing !== undefined) return existing

  const stored = await economy.getRandomDropSettings(guildId)
  return registerDropSession(
    guildId,
    stored ?? DEFAULT_RANDOM_DROP_SETTINGS,
    source
  )
}

function touchDropSession(guildId: string, source: DropPanelSource): void {
  const session = dropPanelSessions.get(guildId)
  if (session === undefined) return

  clearTimeout(session.timeoutHandle)
  session.source = source
  session.timeoutHandle = setTimeout(
    () => void expireDropSession(guildId),
    DROP_PANEL_TIMEOUT_MS
  )
}

function clearDropSession(guildId: string): void {
  const session = dropPanelSessions.get(guildId)
  if (session === undefined) return
  clearTimeout(session.timeoutHandle)
  dropPanelSessions.delete(guildId)
}

async function expireDropSession(guildId: string): Promise<void> {
  const session = dropPanelSessions.get(guildId)
  if (session === undefined) return
  dropPanelSessions.delete(guildId)
  if (!session.dirty) return

  try {
    await economy.setRandomDropSettings(guildId, session.draft)
    const target = await resolveDropPanelMessage(session.source)
    if (target !== null) {
      await target.edit(buildExpiredRandomDropPanel(session.draft))
    }
  } catch (err) {
    logger.warn(
      'Admin',
      `선착보상 패널 만료 처리 실패: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

async function resolveDropPanelMessage(
  source: DropPanelSource
): Promise<Message | null> {
  if (source instanceof MessageComponentInteraction) return source.message
  if (source instanceof ModalSubmitInteraction) return source.message ?? null
  const fetched = await source.fetchReply().catch(() => null)
  return fetched as Message | null
}

function canManageDropPanel(interaction: MessageComponentInteraction): boolean {
  const permissions = interaction.memberPermissions
  if (permissions === null) return false
  return (
    permissions.has(PermissionFlagsBits.Administrator) ||
    permissions.has(PermissionFlagsBits.ManageGuild)
  )
}

function parsePositiveInt(raw: string): number | null {
  const cleaned = raw.trim().replace(/[,\s원회시]/gu, '')
  if (!/^\d+$/u.test(cleaned)) return null
  const value = Number(cleaned)
  return Number.isSafeInteger(value) ? value : null
}

export const setup = async () => {
  return new AdminExtensionClass()
}
