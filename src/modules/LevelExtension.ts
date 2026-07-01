import {
  type LevelTrack,
  createActivityLevelService,
} from '../features/activityLevels/activityLevels'
import { logger } from '../utils/logger'
import { replyEphemeral, replyPublic } from '../utils/replies'
import {
  Extension,
  SubCommandGroup,
  listener,
  option,
} from '@pikokr/command.ts'
import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  type Message,
  type User,
  type VoiceState,
} from 'discord.js'

const levelGroup = new SubCommandGroup({
  name: '레벨',
  description: '경제와 분리된 서버 활동/음성 레벨 명령어',
})

const activityLevels = createActivityLevelService()

type ActiveVoiceSession = {
  readonly channelId: string
  readonly guildId: string
  readonly startedAt: Date
  readonly userId: string
}

const activeVoiceSessions = new Map<string, ActiveVoiceSession>()

function activeVoiceKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}시간 ${minutes}분`
  return `${minutes}분`
}

function parseTrack(value: string): LevelTrack | null {
  if (value === 'text') return 'text'
  if (value === 'voice') return 'voice'
  return null
}

function trackLabel(track: LevelTrack): string {
  return track === 'text' ? '서버 활동' : '음성 활동'
}

class LevelExtensionClass extends Extension {
  @listener({ event: 'clientReady' })
  async ready() {
    const now = new Date()
    for (const guild of this.client.guilds.cache.values()) {
      for (const state of guild.voiceStates.cache.values()) {
        if (state.channelId === null) continue
        if (state.member === null) continue
        if (state.member.user.bot) continue

        activeVoiceSessions.set(activeVoiceKey(guild.id, state.member.id), {
          channelId: state.channelId,
          guildId: guild.id,
          startedAt: now,
          userId: state.member.id,
        })
      }
    }
    logger.info('Level', `음성 세션 ${activeVoiceSessions.size}개 추적 시작`)
  }

  @listener({ event: 'messageCreate' })
  async messageCreate(message: Message) {
    if (message.author.bot) return
    if (message.guild === null) return

    try {
      await activityLevels.recordTextActivity({
        guildId: message.guild.id,
        now: new Date(),
        userId: message.author.id,
      })
    } catch (err) {
      logger.warn(
        'Level',
        `서버 활동 레벨 기록 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  @listener({ event: 'voiceStateUpdate' })
  async voiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
    const member = newState.member ?? oldState.member
    if (member === null) return
    if (member.user.bot) return

    const oldChannelId = oldState.channelId
    const newChannelId = newState.channelId
    if (oldChannelId === newChannelId) return

    const guildId = newState.guild.id
    const userId = member.id
    const key = activeVoiceKey(guildId, userId)
    const now = new Date()

    if (oldChannelId !== null) {
      const active = activeVoiceSessions.get(key)
      if (active !== undefined) {
        activeVoiceSessions.delete(key)
        await this.finishVoiceSession(active, now)
      }
    }

    if (newChannelId !== null) {
      activeVoiceSessions.set(key, {
        channelId: newChannelId,
        guildId,
        startedAt: now,
        userId,
      })
    }
  }

  @levelGroup.command({
    name: '내정보',
    description: '경제와 분리된 서버 활동/음성 레벨을 확인합니다.',
  })
  async profile(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.User,
      name: '유저',
      description: '조회할 유저',
      required: false,
    })
    _target: unknown
  ) {
    if (i.guild === null) {
      await replyEphemeral(i, '서버에서만 사용할 수 있어요.')
      return
    }

    try {
      const user = i.options.getUser('유저') ?? i.user
      const stats = await activityLevels.getStats(i.guild.id, user.id)
      await replyPublic(i, this.buildProfileMessage(user, stats))
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error ? err.message : '레벨 조회 중 오류가 발생했어요.'
      )
    }
  }

  @levelGroup.command({
    name: '랭킹',
    description: '서버 활동 또는 음성 레벨 랭킹을 확인합니다.',
  })
  async ranking(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '종류',
      description: '랭킹 종류',
      choices: [
        { name: '서버 활동', value: 'text' },
        { name: '음성 활동', value: 'voice' },
      ],
      required: true,
    })
    kind: string
  ) {
    if (i.guild === null) {
      await replyEphemeral(i, '서버에서만 사용할 수 있어요.')
      return
    }

    const track = parseTrack(kind)
    if (track === null) {
      await replyEphemeral(i, '랭킹 종류를 다시 선택해 주세요.')
      return
    }

    try {
      const ranking = await activityLevels.getRanking(i.guild.id, track, 10)
      if (ranking.length === 0) {
        await replyPublic(i, `아직 ${trackLabel(track)} 레벨 기록이 없어요.`)
        return
      }

      const lines = ranking.map((entry, index) => {
        const metric =
          track === 'text'
            ? `${entry.metric.toLocaleString()}메시지`
            : formatDuration(entry.metric)
        return `${index + 1}. <@${entry.userId}> | Lv.${
          entry.level
        } · ${entry.xp.toLocaleString()} XP · ${metric}`
      })
      await replyPublic(
        i,
        `🏆 **${trackLabel(track)} 레벨 랭킹 TOP 10**\n\n${lines.join('\n')}`
      )
    } catch (err) {
      await replyEphemeral(
        i,
        err instanceof Error
          ? err.message
          : '레벨 랭킹 조회 중 오류가 발생했어요.'
      )
    }
  }

  private async finishVoiceSession(
    session: ActiveVoiceSession,
    endedAt: Date
  ): Promise<void> {
    try {
      await activityLevels.recordVoiceSession({
        channelId: session.channelId,
        endedAt,
        guildId: session.guildId,
        startedAt: session.startedAt,
        userId: session.userId,
      })
    } catch (err) {
      logger.warn(
        'Level',
        `음성 레벨 기록 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  private buildProfileMessage(
    user: User,
    stats: Awaited<ReturnType<typeof activityLevels.getStats>>
  ): string {
    return [
      `📊 **${user.username}님의 서버 레벨**`,
      '',
      `💬 **서버 활동 레벨** Lv.${stats.text.level}`,
      `XP: ${stats.text.xp.toLocaleString()} / ${stats.text.xpNeeded.toLocaleString()} · 다음 레벨까지 ${stats.text.xpRemaining.toLocaleString()} XP`,
      `메시지 기록: ${stats.text.messageCount.toLocaleString()}개`,
      '',
      `🎙️ **음성 활동 레벨** Lv.${stats.voice.level}`,
      `XP: ${stats.voice.xp.toLocaleString()} / ${stats.voice.xpNeeded.toLocaleString()} · 다음 레벨까지 ${stats.voice.xpRemaining.toLocaleString()} XP`,
      `음성 시간: ${formatDuration(
        stats.voice.totalSeconds
      )} · 세션 ${stats.voice.sessionCount.toLocaleString()}회`,
      '',
      '-# 경제 레벨과 별개로 서버별로 저장됩니다.',
    ].join('\n')
  }
}

export const setup = async () => {
  return new LevelExtensionClass()
}
