import { buildControllerPanel } from '../components/musicPanel'
import { createMusicSettingsService } from '../features/music/musicSettings'
import { logger } from '../utils/logger'
import type { CustomPlayer } from './customPlayer'
import { getVolume, mute, setVolume, unmute } from './volumeStore'
import type { Client, Interaction } from 'discord.js'
import {
  type ButtonInteraction,
  GuildMember,
  MessageFlags,
  type StringSelectMenuInteraction,
} from 'discord.js'
import type { LavalinkManager } from 'lavalink-client'

const PREFIX = 'ctrl:'
const musicSettings = createMusicSettingsService()

function requirePlayer(
  manager: LavalinkManager<CustomPlayer>,
  guildId: string
): CustomPlayer | undefined {
  return manager.getPlayer(guildId)
}

function checkVoiceChannel(
  interaction: ButtonInteraction | StringSelectMenuInteraction
): boolean {
  const member = interaction.member
  if (!(member instanceof GuildMember) || member.voice.channelId === null) {
    void interaction.reply({
      content: '?�성 채널??먼�? ?�어가 주세??',
      flags: MessageFlags.Ephemeral,
    })
    return false
  }

  const botId = interaction.client.user?.id
  if (botId === undefined) {
    void interaction.reply({
      content: '�??�보�?가?�올 ???�어??',
      flags: MessageFlags.Ephemeral,
    })
    return false
  }

  const botVoice = interaction.guild?.members.me?.voice.channelId
  if (botVoice === null || botVoice === undefined) {
    void interaction.reply({
      content: '봇이 ?�성 채널???�어??',
      flags: MessageFlags.Ephemeral,
    })
    return false
  }

  if (member.voice.channelId !== botVoice) {
    void interaction.reply({
      content: '봇과 같�? ?�성 채널???�어???�요.',
      flags: MessageFlags.Ephemeral,
    })
    return false
  }

  return true
}

async function updatePanel(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  player: CustomPlayer
): Promise<void> {
  const panel = buildControllerPanel(player)
  await interaction.editReply({
    components: panel.components,
    flags: MessageFlags.IsComponentsV2,
  })
}

export function registerControllerInteractionHandler(
  client: Client,
  manager: LavalinkManager<CustomPlayer>
): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      // ?�?� Button interactions ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
      if (interaction.isButton()) {
        if (!interaction.customId.startsWith(PREFIX)) return
        const guildId = interaction.guildId
        if (guildId === null) return

        if (!checkVoiceChannel(interaction)) return
        await interaction.deferUpdate()

        const player = requirePlayer(manager, guildId)
        if (player === undefined) {
          await interaction.editReply({
            content: '?�생 중인 봇이 ?�어??',
            components: [],
          })
          return
        }

        const action = interaction.customId.slice(PREFIX.length)

        switch (action) {
          case 'prev': {
            if (player.queue.previous.length === 0) {
              await interaction.editReply({
                content: '?�전 곡이 ?�어??',
                components: [],
              })
              return
            }
            const prevTrack =
              player.queue.previous[player.queue.previous.length - 1]
            if (
              player.queue.current !== undefined &&
              player.queue.current !== null
            ) {
              player.queue.tracks.unshift(player.queue.current)
            }
            await player.play({ clientTrack: prevTrack })
            player.queue.previous.pop()
            player.controllerPage = 1
            break
          }
          case 'pause': {
            if (player.paused) {
              await player.resume()
            } else {
              await player.pause()
            }
            break
          }
          case 'skip': {
            if (player.queue.tracks.length === 0) {
              await interaction.editReply({
                content: '?�음 곡이 ?�어??',
                components: [],
              })
              return
            }
            await player.skip()
            break
          }
          case 'repeat': {
            const modes = ['off', 'queue', 'track'] as const
            const current = (player.repeatMode ?? 'off') as
              | 'off'
              | 'queue'
              | 'track'
            const nextIndex = (modes.indexOf(current) + 1) % modes.length
            await player.setRepeatMode(modes[nextIndex])
            break
          }
          case 'shuffle': {
            if (player.queue.tracks.length < 2) {
              await interaction.editReply({
                content: '?�플??곡이 충분?��? ?�아??',
                components: [],
              })
              return
            }
            player.queue.shuffle()
            break
          }
          case 'stop': {
            await player.destroy()
            return
          }
          case 'tabSettings': {
            player.controllerTab = 'settings'
            musicSettings
              .patchSettings(player.guildId, { controllerTab: 'settings' })
              .catch((err: unknown) => {
                logger.debug(
                  'Music',
                  `patchSettings failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                )
              })
            break
          }
          case 'tabPlayback': {
            player.controllerTab = 'playback'
            musicSettings
              .patchSettings(player.guildId, { controllerTab: 'playback' })
              .catch((err: unknown) => {
                logger.debug(
                  'Music',
                  `patchSettings failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                )
              })
            break
          }
          case 'queueToggle': {
            const visible = player.queueVisible
            player.queueVisible = !visible
            musicSettings
              .patchSettings(player.guildId, {
                queueVisible: player.queueVisible,
              })
              .catch((err: unknown) => {
                logger.debug(
                  'Music',
                  `patchSettings failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                )
              })
            if (!visible) {
              player.controllerPage = 1
            }
            break
          }
          case 'volUp5': {
            const v = Math.min(100, getVolume(player.guildId) + 5)
            setVolume(player.guildId, v)
            await player.setVolume(v)
            musicSettings
              .patchSettings(player.guildId, { volume: v })
              .catch((err: unknown) => {
                logger.debug(
                  'Music',
                  `patchSettings failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                )
              })
            break
          }
          case 'volUp10': {
            const v = Math.min(100, getVolume(player.guildId) + 10)
            setVolume(player.guildId, v)
            await player.setVolume(v)
            musicSettings
              .patchSettings(player.guildId, { volume: v })
              .catch((err: unknown) => {
                logger.debug(
                  'Music',
                  `patchSettings failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                )
              })
            break
          }
          case 'volDown5': {
            const v = Math.max(0, getVolume(player.guildId) - 5)
            setVolume(player.guildId, v)
            await player.setVolume(v)
            musicSettings
              .patchSettings(player.guildId, { volume: v })
              .catch((err: unknown) => {
                logger.debug(
                  'Music',
                  `patchSettings failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                )
              })
            break
          }
          case 'volDown10': {
            const v = Math.max(0, getVolume(player.guildId) - 10)
            setVolume(player.guildId, v)
            await player.setVolume(v)
            musicSettings
              .patchSettings(player.guildId, { volume: v })
              .catch((err: unknown) => {
                logger.debug(
                  'Music',
                  `patchSettings failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                )
              })
            break
          }
          case 'volMute': {
            if (player.volume === 0) {
              const v = unmute(player.guildId)
              await player.setVolume(v)
              musicSettings
                .patchSettings(player.guildId, { volume: v })
                .catch((err: unknown) => {
                  logger.debug(
                    'Music',
                    `patchSettings failed: ${
                      err instanceof Error ? err.message : String(err)
                    }`
                  )
                })
            } else {
              mute(player.guildId)
              await player.setVolume(0)
              musicSettings
                .patchSettings(player.guildId, { volume: 0 })
                .catch((err: unknown) => {
                  logger.debug(
                    'Music',
                    `patchSettings failed: ${
                      err instanceof Error ? err.message : String(err)
                    }`
                  )
                })
            }
            break
          }
          case 'refresh': {
            break
          }
          case 'qprev': {
            if (player.controllerPage > 1) {
              player.controllerPage -= 1
            }
            break
          }
          case 'qnext': {
            const totalPages = Math.max(
              1,
              Math.ceil(player.queue.tracks.length / 5)
            )
            if (player.controllerPage < totalPages) {
              player.controllerPage += 1
            }
            break
          }
          case 'qjump': {
            const selected = player.getData<string>('controllerSelectedTrack')
            if (selected === undefined) {
              await interaction.editReply({
                content: '먼�? ?�택 메뉴?�서 곡을 ?�택??주세??',
                components: [],
              })
              return
            }
            const idx = Number(selected)
            if (
              Number.isNaN(idx) ||
              idx < 1 ||
              idx > player.queue.tracks.length
            ) {
              await interaction.editReply({
                content: '?�바르�? ?��? 번호?�요.',
                components: [],
              })
              return
            }
            await player.skip(idx)
            player.controllerPage = 1
            break
          }
          case 'qrm': {
            const selected = player.getData<string>('controllerSelectedTrack')
            if (selected === undefined) {
              await interaction.editReply({
                content: '먼�? ?�택 메뉴?�서 곡을 ?�택??주세??',
                components: [],
              })
              return
            }
            const idx = Number(selected)
            if (
              Number.isNaN(idx) ||
              idx < 1 ||
              idx > player.queue.tracks.length
            ) {
              await interaction.editReply({
                content: '?�바르�? ?��? 번호?�요.',
                components: [],
              })
              return
            }
            const removed = player.queue.tracks[idx - 1]
            player.queue.remove(idx - 1)
            await interaction.editReply({
              content: `?�� \`#${idx}\` **${
                removed?.info.title ?? '?????�음'
              }**??�? ??��?�어??`,
              components: [],
            })
            return
          }
          default:
            return
        }

        await updatePanel(interaction, player)
        return
      }

      // ?�?� String select menu interactions ?�?�?�?�?�?�?�?�?�?�
      if (interaction.isStringSelectMenu()) {
        if (!interaction.customId.startsWith(PREFIX)) return
        const guildId = interaction.guildId
        if (guildId === null) return

        if (!checkVoiceChannel(interaction)) return
        await interaction.deferUpdate()

        const player = requirePlayer(manager, guildId)
        if (player === undefined) {
          await interaction.editReply({
            content: '?�생 중인 봇이 ?�어??',
            components: [],
          })
          return
        }

        const action = interaction.customId.slice(PREFIX.length)

        switch (action) {
          case 'qsel': {
            const value = interaction.values[0]
            if (value === undefined) return
            player.setData('controllerSelectedTrack', value)
            break
          }
          default:
            return
        }

        await updatePanel(interaction, player)
      }
    } catch (err) {
      logger.error(
        'ControllerInteraction',
        `?�들???�류: ${err instanceof Error ? err.message : String(err)}`
      )
      try {
        if (interaction.isButton() || interaction.isStringSelectMenu()) {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
              content: '?�류가 발생?�어??',
              components: [],
            })
          } else {
            await interaction.reply({
              content: '?�류가 발생?�어??',
              flags: MessageFlags.Ephemeral,
            })
          }
        }
      } catch (err) {
        // ignore secondary errors
      }
    }
  })
}
