import {
  disableBoostCelebration,
  enableBoostCelebration,
  isBoostCelebrationEnabled,
} from '../features/boost/boostCelebrationStore'
import { createEconomyService } from '../features/economy/economy'
import {
  disableSoundboardGuard,
  enableSoundboardGuard,
  isSoundboardGuardEnabled,
} from '../features/soundboard/soundboardGuardStore'
import { requireServerManager } from '../utils/permissions'
import { replyPublic } from '../utils/replies'
import { Extension, SubCommandGroup, option } from '@pikokr/command.ts'
import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
} from 'discord.js'

const adminGroup = new SubCommandGroup({
  name: '서버',
  description: 'FullMoon 서버 관리 명령어',
})
const economy = createEconomyService()

class AdminExtensionClass extends Extension {
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
    name: '선착보상',
    description:
      '선착 보상 설정을 켜거나 끕니다. (기본: 4시~23시, 4회, 1천~5만원)',
  })
  async toggleRandomDrop(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Channel,
      name: '채널',
      description: '보상을 전송할 채널 (지정 안 하면 시스템 채널)',
      required: false,
    })
    _channel: unknown,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '최소금액',
      description: '최소 지급 금액 (기본: 1000)',
      min_value: 1,
      required: false,
    })
    minAmount: number,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '최대금액',
      description: '최대 지급 금액 (기본: 50000)',
      min_value: 1,
      required: false,
    })
    maxAmount: number,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '시작시간',
      description: '보상 시작 시간 (0~23, 기본: 4)',
      min_value: 0,
      max_value: 23,
      required: false,
    })
    startHour: number,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: '종료시간',
      description: '보상 종료 시간 (1~24, 기본: 23)',
      min_value: 1,
      max_value: 24,
      required: false,
    })
    endHour: number,
    @option({
      type: ApplicationCommandOptionType.Channel,
      name: '관리채널',
      description: '오늘 예정 드롭 시간 알림을 받을 채널',
      required: false,
    })
    _adminChannel: unknown
  ) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      return
    }

    const settings = await economy.getRandomDropSettings(guild.id)
    const currentlyEnabled = settings?.enabled ?? false

    if (currentlyEnabled) {
      await economy.setRandomDropSettings(guild.id, { enabled: false })
      await replyPublic(i, '🎁 선착 보상을 **해제**했어요.')
    } else {
      const min = minAmount || settings?.minAmount || 1000
      const max = maxAmount || settings?.maxAmount || 50000
      const start = startHour || settings?.startHour || 4
      const end = endHour || settings?.endHour || 23
      const targetChannel = i.options.getChannel('채널', false)
      const channelId = targetChannel?.id ?? settings?.channelId ?? null
      const adminChannel = i.options.getChannel('관리채널', false)
      const adminChannelId =
        adminChannel?.id ?? settings?.adminChannelId ?? null

      await economy.setRandomDropSettings(guild.id, {
        enabled: true,
        minAmount: min,
        maxAmount: max,
        startHour: start,
        endHour: end,
        channelId,
        adminChannelId,
      })

      const channelLabel = channelId ? `<#${channelId}>` : '시스템 채널'
      const adminLabel = adminChannelId
        ? `<#${adminChannelId}>`
        : '미설정 (알림 없음)'
      await replyPublic(
        i,
        `🎁 선착 보상을 **활성화**했어요.\n전송 채널: ${channelLabel}\n관리 채널: ${adminLabel}\n지급 금액: ${min.toLocaleString()}원 ~ ${max.toLocaleString()}원\n${start}시~${end}시 사이에 하루 4회 랜덤 발송, 선착 4명 수령`
      )
    }
  }
}

export const setup = async () => {
  return new AdminExtensionClass()
}
