import { Extension, SubCommandGroup, option } from '@pikokr/command.ts'
import {
  ApplicationCommandOptionType,
  type CategoryChannel,
  ChannelType,
  ChatInputCommandInteraction,
  type GuildBasedChannel,
  PermissionFlagsBits,
} from 'discord.js'
import { formatKoreanDateTime } from '../config/korea'
import { requireServerManager } from '../utils/permissions'
import { replyEphemeral } from '../utils/replies'

const adminGroup = new SubCommandGroup({ name: '서버', description: 'FullMoon 서버 관리 명령어' })

function channelTypeLabel(type: ChannelType): string {
  switch (type) {
    case ChannelType.GuildAnnouncement:
      return '공지'
    case ChannelType.GuildCategory:
      return '카테고리'
    case ChannelType.GuildForum:
      return '포럼'
    case ChannelType.GuildStageVoice:
      return '스테이지'
    case ChannelType.GuildText:
      return '텍스트'
    case ChannelType.GuildVoice:
      return '음성'
    default:
      return '기타'
  }
}

function formatChannelLine(channel: GuildBasedChannel): string {
  return `- ${channel.name} (${channelTypeLabel(channel.type)})`
}

class AdminExtensionClass extends Extension {
  @adminGroup.command({ name: '채널', description: '서버 채널 목록을 확인합니다.' })
  async channels(i: ChatInputCommandInteraction) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      return
    }

    const channels = [...guild.channels.cache.values()]
      .filter((channel) => channel.type !== ChannelType.GuildCategory)
      .sort((left, right) => left.name.localeCompare(right.name, 'ko-KR'))
      .slice(0, 25)
      .map(formatChannelLine)

    const body = channels.length > 0 ? channels.join('\n') : '표시할 채널이 없어요.'
    await replyEphemeral(i, `현재 서버 채널 목록입니다.\n\n${body}`)
  }

  @adminGroup.command({ name: '카테고리', description: '서버 카테고리 목록을 확인합니다.' })
  async categories(i: ChatInputCommandInteraction) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      return
    }

    const categories = [...guild.channels.cache.values()]
      .filter((channel): channel is CategoryChannel => channel.type === ChannelType.GuildCategory)
      .sort((left, right) => left.rawPosition - right.rawPosition)
      .map((channel) => `- ${channel.name}`)

    const body = categories.length > 0 ? categories.join('\n') : '카테고리가 아직 없어요.'
    await replyEphemeral(i, `현재 서버 카테고리 목록입니다.\n\n${body}`)
  }

  @adminGroup.command({ name: '권한점검', description: '멤버의 서버 관리 권한을 점검합니다.' })
  async auditPermissions(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.User,
      name: '사용자',
      description: '권한을 확인할 사용자',
      required: true,
    })
    _user: unknown,
  ) {
    requireServerManager(i)

    const guild = i.guild
    if (guild === null) {
      return
    }

    const user = i.options.getUser('사용자', true)
    const member = await guild.members.fetch(user.id)
    const permissions = member.permissions
    const rows = [
      `관리자: ${permissions.has(PermissionFlagsBits.Administrator) ? '가능' : '불가'}`,
      `서버 관리: ${permissions.has(PermissionFlagsBits.ManageGuild) ? '가능' : '불가'}`,
      `채널 관리: ${permissions.has(PermissionFlagsBits.ManageChannels) ? '가능' : '불가'}`,
      `역할 관리: ${permissions.has(PermissionFlagsBits.ManageRoles) ? '가능' : '불가'}`,
    ]

    await replyEphemeral(
      i,
      `${member.displayName}님의 서버 관리 권한 점검입니다.\n` +
        `기준 시각: ${formatKoreanDateTime(new Date())}\n\n${rows.join('\n')}`,
    )
  }
}

export const setup = async () => {
  return new AdminExtensionClass()
}
