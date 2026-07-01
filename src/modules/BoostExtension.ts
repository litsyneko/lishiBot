import {
  isBoostCelebrationEnabled,
  loadBoostCelebrationSettings,
} from '../features/boost/boostCelebrationStore'
import { buildBoostEmbed } from '../features/boost/boostMessages'
import { logger } from '../utils/logger'
import { Extension, listener } from '@pikokr/command.ts'
import {
  Events,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js'

class BoostExtensionClass extends Extension {
  private loaded = false

  @listener({ event: 'clientReady' })
  async ready() {
    if (this.loaded) return
    this.loaded = true
    try {
      await loadBoostCelebrationSettings()
    } catch (err) {
      logger.error(
        'BoostCelebration',
        `설정 로드 실패: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  @listener({ event: Events.GuildMemberUpdate })
  async onGuildMemberUpdate(
    oldMember: GuildMember,
    newMember: GuildMember
  ): Promise<void> {
    try {
      const wasBoosting = oldMember.premiumSince !== null
      const isBoosting = newMember.premiumSince !== null

      if (wasBoosting || !isBoosting) return

      const guild = newMember.guild
      if (!isBoostCelebrationEnabled(guild.id)) return

      await this.sendBoostCelebration(guild, newMember)
    } catch (err) {
      logger.error(
        'BoostCelebration',
        `이벤트 처리 실패: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private async sendBoostCelebration(
    guild: Guild,
    member: GuildMember
  ): Promise<void> {
    const targetChannel = this.resolveSystemChannel(guild)
    if (targetChannel === null) {
      logger.warn(
        'BoostCelebration',
        `${guild.name}(${guild.id})에 시스템 채널이 없어 축하 메시지 생략`
      )
      return
    }

    const mention = `<@${member.id}>`
    const embed = buildBoostEmbed(mention)

    await targetChannel.send({ embeds: [embed] })
    logger.info(
      'BoostCelebration',
      `${guild.name}: ${member.user.tag}님이 부스트했습니다.`
    )
  }

  private resolveSystemChannel(guild: Guild): TextChannel | null {
    const systemChannelId = guild.systemChannelId
    if (systemChannelId === null) return null
    const channel = guild.channels.cache.get(systemChannelId)
    if (channel === undefined) return null
    if (!channel.isTextBased()) return null
    return channel as TextChannel
  }
}

export const setup = () => {
  return new BoostExtensionClass()
}
