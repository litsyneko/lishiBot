import {
  type StatsScope,
  type StatsType,
  getGuildStats,
  getPersonalStats,
} from '../features/activityLevels/activityLevelStats'
import { renderActivityStatsCard } from '../features/activityLevels/activityStatsCard'
import { replyEphemeral } from '../utils/replies'
import { levelGroup } from './LevelExtension'
import { Extension, option } from '@pikokr/command.ts'
import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js'

function parseStatsType(value: string): StatsType | null {
  if (value === 'text') return 'text'
  if (value === 'voice') return 'voice'
  return null
}

function parseStatsScope(value: string): StatsScope | null {
  if (value === 'personal') return 'personal'
  if (value === 'guild') return 'guild'
  return null
}

function trackLabel(type: StatsType): string {
  return type === 'text' ? '채팅' : '음성'
}

class StatsExtensionClass extends Extension {
  @levelGroup.command({
    name: '통계',
    description: '서버 활동 통계를 이미지로 확인합니다.',
  })
  async stats(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '타입',
      description: '통계 종류',
      choices: [
        { name: '채팅', value: 'text' },
        { name: '음성', value: 'voice' },
      ],
      required: true,
    })
    typeRaw: string,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '범위',
      description: '통계 범위',
      choices: [
        { name: '내통계', value: 'personal' },
        { name: '전체지표', value: 'guild' },
      ],
      required: true,
    })
    scopeRaw: string
  ) {
    if (i.guild === null) {
      await replyEphemeral(i, '서버에서만 사용할 수 있어요.')
      return
    }

    const type = parseStatsType(typeRaw)
    const scope = parseStatsScope(scopeRaw)
    if (type === null || scope === null) {
      await replyEphemeral(i, '통계 옵션을 다시 선택해 주세요.')
      return
    }

    try {
      if (scope === 'personal') {
        const result = await getPersonalStats(i.guild.id, i.user.id, type)
        const avatarUrl =
          i.user.avatarURL({ extension: 'png', size: 256 }) ??
          i.user.defaultAvatarURL

        const png = await renderActivityStatsCard({
          scope: 'personal',
          username: i.user.username,
          avatarUrl,
          type,
          result,
        })

        const attachment = new AttachmentBuilder(png, {
          name: `stats-${i.user.id}.png`,
        })
        const caption = `📊 **${i.user.username}** 님의 ${trackLabel(
          type
        )} 통계`

        if (i.deferred || i.replied) {
          await i.followUp({ content: caption, files: [attachment] })
          return
        }
        await i.reply({
          content: caption,
          files: [attachment],
          flags: MessageFlags.SuppressEmbeds,
        })
        return
      }

      const guildResult = await getGuildStats(i.guild.id, type)

      const displayNames = new Map<string, string>()
      try {
        const topIds = guildResult.leaderboard.map((e) => e.userId).slice(0, 10)
        if (topIds.length > 0) {
          const members = await i.guild.members.fetch({ user: topIds })
          for (const [id, member] of members) {
            displayNames.set(id, member.displayName)
          }
        }
      } catch {
        // 이름 해석 실패는 치명적이지 않음 — userId 폴백
      }

      const guildIconUrl = i.guild.iconURL({ extension: 'png', size: 256 })

      const png = await renderActivityStatsCard({
        scope: 'guild',
        guildName: i.guild.name,
        guildIconUrl,
        type,
        result: guildResult,
        displayNames,
      })

      const attachment = new AttachmentBuilder(png, {
        name: `stats-guild-${i.guild.id}.png`,
      })
      const caption = `📊 **${i.guild.name}** ${trackLabel(type)} 전체 지표`

      if (i.deferred || i.replied) {
        await i.followUp({ content: caption, files: [attachment] })
        return
      }
      await i.reply({
        content: caption,
        files: [attachment],
        flags: MessageFlags.SuppressEmbeds,
      })
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '통계 조회 중 오류가 발생했어요.'
      )
    }
  }
}

export const setup = async () => {
  return new StatsExtensionClass()
}
