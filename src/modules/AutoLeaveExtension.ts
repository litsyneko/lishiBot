import { Extension, listener } from '@pikokr/command.ts'
import type { VoiceState } from 'discord.js'
import { config } from '../config'
import { createAutoLeaveScheduler } from '../music/autoLeaveTimer'
import { shouldAutoLeave, type ChannelMember } from '../music/voiceState'
import { logger } from '../utils/logger'

class AutoLeaveExtensionClass extends Extension {
  private scheduler = createAutoLeaveScheduler({
    delayMs: 300000,
    schedule: (ms, fn) => setTimeout(fn, ms) as unknown as number,
    cancel: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    leaveGuild: (guildId) => {
      const guild = this.client.guilds.cache.get(guildId)
      if (guild === undefined) {
        return
      }
      const me = guild.members.me
      if (me === null || me === undefined) {
        return
      }
      if (me.voice.channelId === null) {
        return
      }
      void me.voice.disconnect().then(() => {
        logger.info('AutoLeave', `길드 ${guildId}에서 자동 퇴장했어요.`)
      }).catch(() => {
        logger.warn('AutoLeave', `길드 ${guildId} 퇴장 중 오류`)
      })
    },
  })

  @listener({ event: 'voiceStateUpdate' })
  async voiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
    const guildId = newState.guild.id
    const botId = this.client.user?.id
    if (botId === undefined) {
      return
    }

    const botVoiceChannelId = newState.guild.members.me?.voice.channelId
    if (botVoiceChannelId === null || botVoiceChannelId === undefined) {
      return
    }

    const voiceChannel = newState.guild.channels.cache.get(botVoiceChannelId)
    if (voiceChannel === undefined || !('members' in voiceChannel)) {
      return
    }

    const members: ChannelMember[] = [...(voiceChannel as { members: Map<string, { id: string; user: { bot: boolean } }> }).members.values()].map((m) => ({
      id: m.id,
      isBot: m.user.bot,
    }))

    const snapshot = { botId, members }

    if (shouldAutoLeave(snapshot)) {
      this.scheduler.scheduleLeave(guildId)
      logger.debug('AutoLeave', `길드 ${guildId}: 5분 후 자동 퇴장 예약`)
    } else {
      this.scheduler.cancelLeave(guildId)
    }
  }
}

export const setup = async () => {
  return new AutoLeaveExtensionClass()
}
