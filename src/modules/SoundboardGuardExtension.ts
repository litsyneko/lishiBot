import { isSoundboardGuardEnabled } from '../features/soundboard/soundboardGuardStore'
import { logger } from '../utils/logger'
import { Extension, listener } from '@pikokr/command.ts'
import { type Message } from 'discord.js'

const SOUND_LIMIT = 15
const TIMEOUT_MS = 30_000
const WINDOW_MS = 10_000

type UserEntry = {
  count: number
  firstAt: number
  mutedUntil: number
}

class SoundboardGuardExtensionClass extends Extension {
  private counters = new Map<string, UserEntry>()

  private getKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`
  }

  @listener({ event: 'raw' })
  async raw(payload: unknown) {
    try {
      const data = payload as {
        t?: string
        d?: {
          guild_id?: string
          user_id?: string
          channel_id?: string
          sound_id?: string | number
        }
      }

      if (data.t === 'VOICE_CHANNEL_EFFECT_SEND') {
        logger.info(
          'SoundboardGuard',
          `이벤트 수신: guild=${data.d?.guild_id} user=${data.d?.user_id} sound=${data.d?.sound_id}`
        )
      }

      if (data.t !== 'VOICE_CHANNEL_EFFECT_SEND') return

      const guildId = data.d?.guild_id
      const userId = data.d?.user_id
      const soundId = data.d?.sound_id
      if (
        guildId === undefined ||
        userId === undefined ||
        soundId === undefined
      )
        return

      logger.info(
        'SoundboardGuard',
        `활성화 상태: guild=${guildId} enabled=${isSoundboardGuardEnabled(
          guildId
        )}`
      )

      if (!isSoundboardGuardEnabled(guildId)) return

      const guild = this.client.guilds.cache.get(guildId)
      if (guild === undefined) return

      const member = await guild.members.fetch(userId).catch(() => undefined)
      if (member === undefined || member.user.bot) return

      const key = this.getKey(guildId, userId)
      const now = Date.now()
      const entry = this.counters.get(key)

      if (entry !== undefined && now < entry.mutedUntil) {
        logger.info(
          'SoundboardGuard',
          `${member.displayName}: 이미 제한 중 (${entry.count}회, mute 유지)`
        )
        return
      }

      if (entry === undefined || now - entry.firstAt > WINDOW_MS) {
        this.counters.set(key, { count: 1, firstAt: now, mutedUntil: 0 })
        logger.info(
          'SoundboardGuard',
          `${member.displayName}: 카운터 시작/리셋`
        )
        return
      }

      entry.count += 1
      logger.info(
        'SoundboardGuard',
        `${member.displayName}: ${entry.count}/${SOUND_LIMIT} (윈도우 ${
          ((now - entry.firstAt) / 1000) | 0
        }초)`
      )

      if (entry.count > SOUND_LIMIT) {
        entry.mutedUntil = now + TIMEOUT_MS

        try {
          const voiceChannel = member.voice.channel
          if (voiceChannel === null) {
            this.counters.delete(key)
            return
          }

          const channel = guild.channels.cache.get(voiceChannel.id)
          if (channel === undefined || !channel.isVoiceBased()) {
            this.counters.delete(key)
            return
          }

          await channel.permissionOverwrites.edit(
            member.id,
            {
              UseSoundboard: false,
            },
            { reason: '사운드보드 스팸 (자동 제어)' }
          )

          await member.voice.setMute(true, '사운드보드 스팸 (자동 제어)')

          logger.info(
            'SoundboardGuard',
            `${guild.name} - ${member.displayName}: 사운드보드 ${entry.count}회 사용 → 30초 사운드보드+음소거 제한`
          )

          const alertMsg: Message<true> = await voiceChannel.send({
            content: `<@${member.id}>님, 사운드보드를 너무 빠르게 많이 사용하셨어요! 다른 분들이 불편할 수 있으니 조금만 천천히 사용해주세요\n지금부터 **30초간** 사운드보드 사용이 제한됩니다.\n-# 제한은 30초 후 자동으로 해제돼요. 이 메시지도 함께 사라져요.`,
            stickers: ['1520216939665035414'],
          })

          setTimeout(() => {
            alertMsg.delete().catch((err: unknown) => {
              logger.debug(
                'Soundboard',
                `alert delete failed: ${
                  err instanceof Error ? err.message : String(err)
                }`
              )
            })
          }, TIMEOUT_MS)

          setTimeout(async () => {
            try {
              const ch = guild.channels.cache.get(voiceChannel.id)
              if (ch !== undefined && ch.isVoiceBased()) {
                await ch.permissionOverwrites.delete(
                  member.id,
                  '사운드보드 제한 해제'
                )
              }
              const freshMember = await guild.members
                .fetch(userId)
                .catch(() => undefined)
              if (
                freshMember !== undefined &&
                freshMember.voice.channel !== null
              ) {
                await freshMember.voice
                  .setMute(false, '사운드보드 제한 해제')
                  .catch((err: unknown) => {
                    logger.debug(
                      'Soundboard',
                      `unmute failed: ${
                        err instanceof Error ? err.message : String(err)
                      }`
                    )
                  })
              }
            } catch (err) {
              logger.error(
                'SoundboardGuard',
                `${guild.name} - ${member.displayName}: 제한 해제 실패 - ${
                  err instanceof Error ? err.message : String(err)
                }`
              )
            }
            this.counters.delete(key)
          }, TIMEOUT_MS)
        } catch (err) {
          logger.error(
            'SoundboardGuard',
            `${guild.name} - ${member.displayName}: 제한 적용 실패 - ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
    } catch (err) {
      logger.error(
        'SoundboardGuard',
        `이벤트 처리 오류 - ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

export const setup = async () => {
  return new SoundboardGuardExtensionClass()
}
