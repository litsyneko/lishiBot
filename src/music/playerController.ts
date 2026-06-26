import type { LavalinkManager, Track } from 'lavalink-client'
import type { Client, GuildTextBasedChannel } from 'discord.js'
import { MessageFlags } from 'discord.js'
import { buildControllerPanel, buildStoppedPanel, type PanelTrackInfo } from '../components/musicPanel'
import type { CustomPlayer } from './customPlayer'

const DEBOUNCE_MS = 300

function isUnknownMessageError(error: unknown): boolean {
  const code = (error as { code?: number }).code
  return code === 10008
}

export type PlayerControllerManager = {
  readonly sendController: (player: CustomPlayer) => Promise<void>
  readonly deleteController: (player: CustomPlayer) => Promise<void>
  readonly onTrackStart: (player: CustomPlayer) => Promise<void>
  readonly onQueueEnd: (player: CustomPlayer) => Promise<void>
  readonly onPlayerDestroy: (player: CustomPlayer) => Promise<void>
}

const debounceTimers = new Map<string, NodeJS.Timeout>()

function clearDebounce(guildId: string): void {
  const timer = debounceTimers.get(guildId)
  if (timer !== undefined) {
    clearTimeout(timer)
    debounceTimers.delete(guildId)
  }
}

export function createPlayerControllerManager(
  client: Client,
  manager: LavalinkManager<CustomPlayer>,
  resolveChannel: (guildId: string, playerTextChannelId: string | null | undefined) => Promise<GuildTextBasedChannel | undefined>,
): PlayerControllerManager {
  // ── helpers ──────────────────────────────────────



  // ── delete ───────────────────────────────────────

  async function tryDeleteMessage(guildId: string, channelId: string, messageId: string): Promise<void> {
    const guild = client.guilds.cache.get(guildId)
    if (guild === undefined) return
    const channel = guild.channels.cache.get(channelId)
    if (channel === undefined || !('messages' in channel)) return
    try {
      await (channel as GuildTextBasedChannel).messages.delete(messageId)
    } catch {
      // already deleted
    }
  }

  async function deleteController(player: CustomPlayer, _force = false): Promise<void> {
    clearDebounce(player.guildId)

    const messageId = player.controllerMessageId
    const channelId = player.controllerChannelId
    player.controllerMessageId = undefined
    player.controllerChannelId = undefined

    if (messageId !== undefined && channelId !== undefined) {
      await tryDeleteMessage(player.guildId, channelId, messageId)
    }
  }

  // ── send ─────────────────────────────────────────

  async function sendController(player: CustomPlayer): Promise<void> {
    // Delete previous controller first
    await deleteController(player)

    const channel = await resolveChannel(player.guildId, player.textChannelId)
    if (channel === undefined) return

    const current = player.queue.current
    if (current === undefined || current === null) return

    const panel = buildControllerPanel(player)

    try {
      const msg = await channel.send({
        components: panel.components as never[],
        flags: MessageFlags.IsComponentsV2,
      })

      player.controllerMessageId = msg.id
      player.controllerChannelId = channel.id
    } catch {
      // channel might be unwritable
    }
  }

  // ── update (debounced) ───────────────────────────

  function scheduleUpdate(player: CustomPlayer): void {
    clearDebounce(player.guildId)

    const timer = setTimeout(async () => {
      debounceTimers.delete(player.guildId)
      await performUpdate(player)
    }, DEBOUNCE_MS)

    debounceTimers.set(player.guildId, timer)
  }

  async function performUpdate(player: CustomPlayer): Promise<void> {
    const messageId = player.controllerMessageId
    const channelId = player.controllerChannelId
    if (messageId === undefined || channelId === undefined) return

    const guild = client.guilds.cache.get(player.guildId)
    if (guild === undefined) return
    const channel = guild.channels.cache.get(channelId)
    if (channel === undefined || !('messages' in channel)) return

    const current = player.queue.current
    if (current === undefined || current === null) {
      await deleteController(player)
      return
    }

    const panel = buildControllerPanel(player)

    try {
      await (channel as GuildTextBasedChannel).messages.edit(messageId, {
        components: panel.components as never[],
        flags: MessageFlags.IsComponentsV2,
      })
    } catch (err) {
      if (isUnknownMessageError(err)) {
        player.controllerMessageId = undefined
        player.controllerChannelId = undefined
      }
    }
  }

  // ── event handlers ───────────────────────────────

  async function onTrackStart(player: CustomPlayer): Promise<void> {
    clearDebounce(player.guildId)

    const messageId = player.controllerMessageId
    const channelId = player.controllerChannelId

    if (messageId !== undefined && channelId !== undefined) {
      const guild = client.guilds.cache.get(player.guildId)
      const channel = guild?.channels.cache.get(channelId)

      if (
        channel !== undefined &&
        'messages' in channel &&
        (channel as GuildTextBasedChannel).lastMessageId === messageId
      ) {
        const current = player.queue.current
        if (current === undefined || current === null) return

        const panel = buildControllerPanel(player)
        try {
          await (channel as GuildTextBasedChannel).messages.edit(messageId, {
            components: panel.components as never[],
            flags: MessageFlags.IsComponentsV2,
          })
          return
        } catch (err) {
          if (isUnknownMessageError(err)) {
            player.controllerMessageId = undefined
            player.controllerChannelId = undefined
          }
        }
      }
    }

    await sendController(player)
  }

  async function onQueueEnd(player: CustomPlayer): Promise<void> {
    clearDebounce(player.guildId)

    const messageId = player.controllerMessageId
    const channelId = player.controllerChannelId
    const lastTrack = player.queue.current ?? undefined

    player.controllerMessageId = undefined
    player.controllerChannelId = undefined

    if (messageId !== undefined && channelId !== undefined) {
      await replaceWithStoppedPanel(player.guildId, channelId, messageId, lastTrack)
    }
  }

  async function onPlayerDestroy(player: CustomPlayer): Promise<void> {
    clearDebounce(player.guildId)

    const messageId = player.controllerMessageId
    const channelId = player.controllerChannelId
    const lastTrack = player.queue.current ?? undefined

    player.controllerMessageId = undefined
    player.controllerChannelId = undefined

    if (messageId !== undefined && channelId !== undefined) {
      await replaceWithStoppedPanel(player.guildId, channelId, messageId, lastTrack)
    }
  }

  async function replaceWithStoppedPanel(
    guildId: string,
    channelId: string,
    messageId: string,
    lastTrack: Track | undefined,
  ): Promise<void> {
    const guild = client.guilds.cache.get(guildId)
    if (guild === undefined) return
    const channel = guild.channels.cache.get(channelId)
    if (channel === undefined || !('messages' in channel)) return

    let trackInfo: PanelTrackInfo | undefined
    if (lastTrack !== undefined && lastTrack.info !== undefined) {
      const info = lastTrack.info
      trackInfo = {
        title: info.title ?? '알 수 없음',
        author: info.author ?? '알 수 없음',
        durationMs: info.duration ?? 0,
        artworkUrl: info.artworkUrl ?? undefined,
        identifier: info.identifier,
        sourceName: info.sourceName,
        uri: info.uri,
      }
    }

    const panel = buildStoppedPanel({ track: trackInfo })

    try {
      await (channel as GuildTextBasedChannel).messages.edit(messageId, {
        components: panel.components as never[],
        flags: MessageFlags.IsComponentsV2,
      })
    } catch {
    }
  }

  // ── playerUpdate listener ────────────────────────
  // Debounced progress/state update from Lavalink

  manager.on('playerUpdate', (_old: unknown, player: CustomPlayer) => {
    if (player.queue.current === undefined || player.queue.current === null) return
    if (player.controllerMessageId === undefined) return
    scheduleUpdate(player)
  })

  return {
    sendController,
    deleteController,
    onTrackStart,
    onQueueEnd,
    onPlayerDestroy,
  }
}
