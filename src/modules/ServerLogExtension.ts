import {
  type ServerLogCategory,
  categoryForAuditAction,
  isServerLogCategory,
} from '../features/serverLogs/serverLogCategories'
import { buildServerLogMessage } from '../features/serverLogs/serverLogMessage'
import {
  SERVER_LOG_COMPONENT_PREFIX,
  SERVER_LOG_PAGE_COUNT,
  buildCancelledServerLogPanel,
  buildExpiredServerLogPanel,
  buildServerLogPanel,
} from '../features/serverLogs/serverLogPanel'
import {
  commitDraft,
  discardDraft,
  getDraftServerLogSettings,
  getServerLogSettings,
  hasDraft,
  loadServerLogSettings,
  updateDraft,
} from '../features/serverLogs/serverLogSettings'
import { logger } from '../utils/logger'
import { requireServerManager } from '../utils/permissions'
import { Extension, applicationCommand, listener } from '@pikokr/command.ts'
import {
  ApplicationCommandType,
  ChatInputCommandInteraction,
  Guild,
  GuildAuditLogsEntry,
  type GuildBasedChannel,
  Interaction,
  Message,
  MessageComponentInteraction,
  MessageFlags,
  NewsChannel,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js'

const SESSION_TIMEOUT_MS = 3 * 60 * 1000

type PanelSession = {
  readonly guildId: string
  page: number
  timeoutHandle: NodeJS.Timeout
}

const panelSessions = new Map<string, PanelSession>()

class ServerLogExtensionClass extends Extension {
  private loaded = false

  @listener({ event: 'clientReady' })
  async ready(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    try {
      await loadServerLogSettings()
    } catch (err) {
      logger.error(
        'ServerLog',
        `설정 로드 실패: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  @applicationCommand({
    name: '관리로그',
    type: ApplicationCommandType.ChatInput,
    description: '서버 관리 감사 로그 추적을 설정합니다.',
  })
  async settings(i: ChatInputCommandInteraction): Promise<void> {
    requireServerManager(i)
    if (i.guild === null) return

    const draft = getDraftServerLogSettings(i.guild.id)
    const draftPending = hasDraft(i.guild.id)
    await i.reply(buildServerLogPanel(draft, 0, draftPending))
    registerSession(i.guild.id, 0, i)
  }

  @listener({ event: 'interactionCreate' })
  async onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isMessageComponent()) return
    if (!interaction.customId.startsWith(SERVER_LOG_COMPONENT_PREFIX)) return
    if (interaction.guild === null) return

    if (!canManageServer(interaction)) {
      await interaction.reply({
        content: '서버 관리 권한이 있는 사용자만 설정을 바꿀 수 있어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const guildId = interaction.guild.id
    const result = await handleSettingsInteraction(interaction, guildId)

    if (result.kind === 'cancelled') {
      await interaction.update(buildCancelledServerLogPanel())
      clearSession(guildId)
      return
    }

    await interaction.update(
      buildServerLogPanel(result.settings, result.page, hasDraft(guildId))
    )
    refreshSession(guildId, result.page, interaction)
  }

  @listener({ event: 'guildAuditLogEntryCreate' })
  async onAuditLogEntry(
    entry: GuildAuditLogsEntry,
    guild: Guild
  ): Promise<void> {
    const category = categoryForAuditAction(entry.action)
    if (category === null) return

    try {
      const settings = await getServerLogSettings(guild.id)
      if (!settings.enabled) return

      const channelId = settings.categoryChannels[category]
      if (channelId === null || channelId === undefined) return

      const channel = guild.channels.cache.get(channelId)
      if (!isSendableLogChannel(channel)) return

      await channel.send({
        allowedMentions: { parse: [] },
        components: [buildServerLogMessage(entry, category)],
        flags: MessageFlags.IsComponentsV2,
      })
    } catch (err) {
      logger.error(
        'ServerLog',
        `감사 로그 전송 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
}

type InteractionResult =
  | {
      readonly kind: 'update'
      readonly settings: ReturnType<typeof getDraftServerLogSettings>
      readonly page: number
    }
  | { readonly kind: 'cancelled' }

async function handleSettingsInteraction(
  interaction: MessageComponentInteraction,
  guildId: string
): Promise<InteractionResult> {
  const action = interaction.customId.slice(SERVER_LOG_COMPONENT_PREFIX.length)
  const session = panelSessions.get(guildId)
  const currentPage = session?.page ?? 0

  if (interaction.isChannelSelectMenu() && action.startsWith('cat:')) {
    const category = action.slice('cat:'.length)
    if (!isServerLogCategory(category)) {
      return {
        kind: 'update',
        page: currentPage,
        settings: getDraftServerLogSettings(guildId),
      }
    }

    const selectedId = interaction.values[0]
    const channelId = selectedId === undefined ? null : selectedId

    const settings = updateDraft(guildId, {
      categoryChannels: { [category]: channelId },
      enabled: channelId !== undefined,
    })
    return { kind: 'update', page: currentPage, settings }
  }

  if (interaction.isButton() && action.startsWith('page:')) {
    const requested = Number(action.slice('page:'.length))
    const page = clampPage(requested)
    return {
      kind: 'update',
      page,
      settings: getDraftServerLogSettings(guildId),
    }
  }

  if (interaction.isButton() && action === 'toggle') {
    const current = getDraftServerLogSettings(guildId)
    const settings = updateDraft(guildId, { enabled: !current.enabled })
    return { kind: 'update', page: currentPage, settings }
  }

  if (interaction.isButton() && action === 'clear') {
    const settings = updateDraft(guildId, {
      categoryChannels: emptyCategoryChannelMap(),
    })
    return { kind: 'update', page: currentPage, settings }
  }

  if (interaction.isButton() && action === 'save') {
    const settings = await commitDraft(guildId)
    return { kind: 'update', page: currentPage, settings }
  }

  if (interaction.isButton() && action === 'cancel') {
    discardDraft(guildId)
    return { kind: 'cancelled' }
  }

  return {
    kind: 'update',
    page: currentPage,
    settings: getDraftServerLogSettings(guildId),
  }
}

function registerSession(
  guildId: string,
  page: number,
  source: ChatInputCommandInteraction | MessageComponentInteraction
): void {
  const existing = panelSessions.get(guildId)
  if (existing !== undefined) {
    clearTimeout(existing.timeoutHandle)
  }

  const handle = setTimeout(
    () => void expireSession(guildId, source),
    SESSION_TIMEOUT_MS
  )
  panelSessions.set(guildId, { guildId, page, timeoutHandle: handle })
}

function refreshSession(
  guildId: string,
  page: number,
  source: MessageComponentInteraction
): void {
  const existing = panelSessions.get(guildId)
  if (existing !== undefined) {
    clearTimeout(existing.timeoutHandle)
  }

  const handle = setTimeout(
    () => void expireSession(guildId, source),
    SESSION_TIMEOUT_MS
  )
  panelSessions.set(guildId, { guildId, page, timeoutHandle: handle })
}

function clearSession(guildId: string): void {
  const existing = panelSessions.get(guildId)
  if (existing !== undefined) {
    clearTimeout(existing.timeoutHandle)
  }
  panelSessions.delete(guildId)
}

async function expireSession(
  guildId: string,
  source: ChatInputCommandInteraction | MessageComponentInteraction
): Promise<void> {
  const session = panelSessions.get(guildId)
  if (session === undefined) return

  panelSessions.delete(guildId)

  const draftPending = hasDraft(guildId)
  if (draftPending) {
    const settings = await commitDraft(guildId)
    await applyExpiredPanel(source, buildExpiredServerLogPanel(settings))
  }
}

async function applyExpiredPanel(
  source: ChatInputCommandInteraction | MessageComponentInteraction,
  panel: ReturnType<typeof buildExpiredServerLogPanel>
): Promise<void> {
  try {
    const target =
      source instanceof MessageComponentInteraction
        ? source.message
        : await fetchReplyMessage(source)

    if (target === null) return
    await target.edit(panel)
  } catch (err) {
    logger.debug(
      'ServerLog',
      `만료 패널 처리 실패: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

async function fetchReplyMessage(
  interaction: ChatInputCommandInteraction
): Promise<Message | null> {
  const fetched = await interaction.fetchReply().catch(() => null)
  if (fetched === null) return null
  return fetched as Message<true>
}

function clampPage(page: number): number {
  return Math.max(0, Math.min(SERVER_LOG_PAGE_COUNT - 1, page))
}

function canManageServer(interaction: MessageComponentInteraction): boolean {
  const permissions = interaction.memberPermissions
  if (permissions === null) return false
  return (
    permissions.has(PermissionFlagsBits.Administrator) ||
    permissions.has(PermissionFlagsBits.ManageGuild)
  )
}

function isSendableLogChannel(
  channel: GuildBasedChannel | undefined
): channel is TextChannel | NewsChannel {
  return channel instanceof TextChannel || channel instanceof NewsChannel
}

function emptyCategoryChannelMap(): Record<ServerLogCategory, string | null> {
  const result = {} as Record<ServerLogCategory, string | null>
  for (const key of Object.keys(result) as ServerLogCategory[]) {
    result[key] = null
  }
  return result
}

export const setup = () => {
  return new ServerLogExtensionClass()
}
