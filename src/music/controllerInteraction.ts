import type { Client, Interaction } from 'discord.js'
import { MessageFlags, GuildMember, type ButtonInteraction, type StringSelectMenuInteraction } from 'discord.js'
import type { LavalinkManager } from 'lavalink-client'
import { buildControllerPanel } from '../components/musicPanel'
import type { CustomPlayer } from './customPlayer'
import { getVolume, setVolume, mute, unmute } from './volumeStore'
import { createMusicSettingsService } from '../features/music/musicSettings'
import { logger } from '../utils/logger'

const PREFIX = 'ctrl:'
const musicSettings = createMusicSettingsService()

function requirePlayer(manager: LavalinkManager<CustomPlayer>, guildId: string): CustomPlayer | undefined {
  return manager.getPlayer(guildId)
}

function checkVoiceChannel(interaction: ButtonInteraction | StringSelectMenuInteraction): boolean {
  const member = interaction.member
  if (!(member instanceof GuildMember) || member.voice.channelId === null) {
    void interaction.reply({ content: '음성 채널에 먼저 들어가 주세요.', flags: MessageFlags.Ephemeral })
    return false
  }

  const botId = interaction.client.user?.id
  if (botId === undefined) {
    void interaction.reply({ content: '봇 정보를 가져올 수 없어요.', flags: MessageFlags.Ephemeral })
    return false
  }

  const botVoice = interaction.guild?.members.me?.voice.channelId
  if (botVoice === null || botVoice === undefined) {
    void interaction.reply({ content: '봇이 음성 채널에 없어요.', flags: MessageFlags.Ephemeral })
    return false
  }

  if (member.voice.channelId !== botVoice) {
    void interaction.reply({ content: '봇과 같은 음성 채널에 있어야 해요.', flags: MessageFlags.Ephemeral })
    return false
  }

  return true
}

async function updatePanel(interaction: ButtonInteraction | StringSelectMenuInteraction, player: CustomPlayer): Promise<void> {
  const panel = buildControllerPanel(player)
  await interaction.editReply({
    components: panel.components as never[],
    flags: MessageFlags.IsComponentsV2,
  })
}

export function registerControllerInteractionHandler(client: Client, manager: LavalinkManager<CustomPlayer>): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      // ── Button interactions ──────────────────────
      if (interaction.isButton()) {
        if (!interaction.customId.startsWith(PREFIX)) return
        const guildId = interaction.guildId
        if (guildId === null) return

        if (!checkVoiceChannel(interaction)) return
        await interaction.deferUpdate()

        const player = requirePlayer(manager, guildId)
        if (player === undefined) {
          await interaction.editReply({ content: '재생 중인 봇이 없어요.', components: [] })
          return
        }

        const action = interaction.customId.slice(PREFIX.length)

        switch (action) {
          case 'prev': {
            if (player.queue.previous.length === 0) {
              await interaction.editReply({ content: '이전 곡이 없어요.', components: [] })
              return
            }
            const prevTrack = player.queue.previous[player.queue.previous.length - 1]
            if (player.queue.current !== undefined && player.queue.current !== null) {
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
              await interaction.editReply({ content: '다음 곡이 없어요.', components: [] })
              return
            }
            await player.skip()
            break
          }
          case 'repeat': {
            const modes = ['off', 'queue', 'track'] as const
            const current = (player.repeatMode ?? 'off') as 'off' | 'queue' | 'track'
            const nextIndex = (modes.indexOf(current) + 1) % modes.length
            await player.setRepeatMode(modes[nextIndex])
            break
          }
          case 'shuffle': {
            if (player.queue.tracks.length < 2) {
              await interaction.editReply({ content: '셔플할 곡이 충분하지 않아요.', components: [] })
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
            musicSettings.patchSettings(player.guildId, { controllerTab: 'settings' }).catch(() => {})
            break
          }
          case 'tabPlayback': {
            player.controllerTab = 'playback'
            musicSettings.patchSettings(player.guildId, { controllerTab: 'playback' }).catch(() => {})
            break
          }
          case 'queueToggle': {
            const visible = player.queueVisible
            player.queueVisible = !visible
            musicSettings.patchSettings(player.guildId, { queueVisible: player.queueVisible }).catch(() => {})
            if (!visible) {
              player.controllerPage = 1
            }
            break
          }
          case 'volUp5': {
            const v = Math.min(100, getVolume(player.guildId) + 5)
            setVolume(player.guildId, v)
            await player.setVolume(v)
            musicSettings.patchSettings(player.guildId, { volume: v }).catch(() => {})
            break
          }
          case 'volUp10': {
            const v = Math.min(100, getVolume(player.guildId) + 10)
            setVolume(player.guildId, v)
            await player.setVolume(v)
            musicSettings.patchSettings(player.guildId, { volume: v }).catch(() => {})
            break
          }
          case 'volDown5': {
            const v = Math.max(0, getVolume(player.guildId) - 5)
            setVolume(player.guildId, v)
            await player.setVolume(v)
            musicSettings.patchSettings(player.guildId, { volume: v }).catch(() => {})
            break
          }
          case 'volDown10': {
            const v = Math.max(0, getVolume(player.guildId) - 10)
            setVolume(player.guildId, v)
            await player.setVolume(v)
            musicSettings.patchSettings(player.guildId, { volume: v }).catch(() => {})
            break
          }
          case 'volMute': {
            if (player.volume === 0) {
              const v = unmute(player.guildId)
              await player.setVolume(v)
              musicSettings.patchSettings(player.guildId, { volume: v }).catch(() => {})
            } else {
              mute(player.guildId)
              await player.setVolume(0)
              musicSettings.patchSettings(player.guildId, { volume: 0 }).catch(() => {})
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
            const totalPages = Math.max(1, Math.ceil(player.queue.tracks.length / 5))
            if (player.controllerPage < totalPages) {
              player.controllerPage += 1
            }
            break
          }
          case 'qjump': {
            const selected = player.getData<string>('controllerSelectedTrack')
            if (selected === undefined) {
              await interaction.editReply({ content: '먼저 선택 메뉴에서 곡을 선택해 주세요.', components: [] })
              return
            }
            const idx = Number(selected)
            if (Number.isNaN(idx) || idx < 1 || idx > player.queue.tracks.length) {
              await interaction.editReply({ content: '올바르지 않은 번호예요.', components: [] })
              return
            }
            await player.skip(idx)
            player.controllerPage = 1
            break
          }
          case 'qrm': {
            const selected = player.getData<string>('controllerSelectedTrack')
            if (selected === undefined) {
              await interaction.editReply({ content: '먼저 선택 메뉴에서 곡을 선택해 주세요.', components: [] })
              return
            }
            const idx = Number(selected)
            if (Number.isNaN(idx) || idx < 1 || idx > player.queue.tracks.length) {
              await interaction.editReply({ content: '올바르지 않은 번호예요.', components: [] })
              return
            }
            const removed = player.queue.tracks[idx - 1]
            player.queue.remove(idx - 1)
            await interaction.editReply({
              content: `🗑 \`#${idx}\` **${removed?.info.title ?? '알 수 없음'}**을(를) 삭제했어요.`,
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

      // ── String select menu interactions ──────────
      if (interaction.isStringSelectMenu()) {
        if (!interaction.customId.startsWith(PREFIX)) return
        const guildId = interaction.guildId
        if (guildId === null) return

        if (!checkVoiceChannel(interaction)) return
        await interaction.deferUpdate()

        const player = requirePlayer(manager, guildId)
        if (player === undefined) {
          await interaction.editReply({ content: '재생 중인 봇이 없어요.', components: [] })
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
      logger.error('ControllerInteraction', `핸들러 오류: ${err instanceof Error ? err.message : String(err)}`)
      try {
        if (interaction.isButton() || interaction.isStringSelectMenu()) {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: '오류가 발생했어요.', components: [] })
          } else {
            await interaction.reply({ content: '오류가 발생했어요.', flags: MessageFlags.Ephemeral })
          }
        }
      } catch {
        // ignore secondary errors
      }
    }
  })
}
