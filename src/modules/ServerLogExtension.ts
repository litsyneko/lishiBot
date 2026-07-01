import {
  type ServerLogCategory,
  categoryForAuditAction,
  isServerLogCategory,
} from '../features/serverLogs/serverLogCategories'
import {
  type MemberActivity,
  type MessageActivity,
  type ReactionActivity,
  describeMemberJoin,
  describeMemberLeave,
  describeMessageDelete,
  describeMessageEdit,
  describeReactionAdd,
  describeReactionRemove,
  detectVoiceActivity,
} from '../features/serverLogs/serverLogEvents'
import {
  buildMemberLogMessage,
  buildMessageLogMessage,
  buildReactionLogMessage,
  buildServerLogMessage,
  buildVoiceLogMessage,
} from '../features/serverLogs/serverLogMessage'
import {
  SERVER_LOG_COMPONENT_PREFIX,
  SERVER_LOG_PAGE_COUNT,
  buildCancelledServerLogPanel,
  buildExpiredServerLogPanel,
  buildSavedServerLogPanel,
  buildServerLogPanel,
} from '../features/serverLogs/serverLogPanel'
import {
  type ServerLogSettings,
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
  type Client,
  type Collection,
  Events,
  Guild,
  GuildAuditLogsEntry,
  type GuildBasedChannel,
  type GuildMember,
  Interaction,
  Message,
  MessageComponentInteraction,
  MessageFlags,
  type MessageReaction,
  NewsChannel,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  PermissionFlagsBits,
  TextChannel,
  type User,
  VoiceState,
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

    if (result.kind === 'saved') {
      await interaction.update(buildSavedServerLogPanel(result.settings))
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
        components: [
          buildServerLogMessage(entry, category, guild, this.client),
        ],
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

  @listener({ event: Events.MessageUpdate })
  async onMessageUpdate(
    oldMessage: Message | PartialMessage,
    newMessage: Message | PartialMessage
  ): Promise<void> {
    if (oldMessage.guild === null || oldMessage.author?.bot === true) return

    const guild = oldMessage.guild
    if (oldMessage.content === newMessage.content) return

    await sendMessageLog(
      guild,
      describeMessageEdit(oldMessage, newMessage),
      'messages',
      this.client
    )
  }

  @listener({ event: Events.MessageDelete })
  async onMessageDelete(message: Message | PartialMessage): Promise<void> {
    if (message.guild === null || message.author?.bot === true) return

    const guild = message.guild

    await sendMessageLog(
      guild,
      describeMessageDelete(message),
      'messages',
      this.client
    )
  }

  @listener({ event: Events.MessageBulkDelete })
  async onMessageBulkDelete(
    messages: Collection<string, Message | PartialMessage>,
    channel: GuildBasedChannel
  ): Promise<void> {
    if (channel.guild === undefined) return
    const guild = channel.guild

    const activity: MessageActivity = {
      authorId: null,
      authorTag: null,
      channelId: channel.id,
      count: messages.size,
      kind: 'bulkDelete',
      messageId: 'bulk',
      newContent: null,
      oldContent: null,
    }

    await sendMessageLog(guild, activity, 'messages', this.client)
  }

  @listener({ event: Events.VoiceStateUpdate })
  async onVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState
  ): Promise<void> {
    if (oldState.guild === undefined) return
    const guild = oldState.guild

    const activity = detectVoiceActivity(oldState, newState)
    if (activity === null) return

    const settings = await getServerLogSettings(guild.id)
    if (!settings.enabled) return

    const channelId = settings.categoryChannels.voice
    if (channelId === null || channelId === undefined) return

    const logChannel = guild.channels.cache.get(channelId)
    if (!isSendableLogChannel(logChannel)) return

    try {
      await logChannel.send({
        allowedMentions: { parse: [] },
        components: [
          buildVoiceLogMessage(activity, 'voice', guild, this.client),
        ],
        flags: MessageFlags.IsComponentsV2,
      })
    } catch (err) {
      logger.error(
        'ServerLog',
        `음성 로그 전송 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
  @listener({ event: Events.GuildMemberAdd })
  async onGuildMemberAdd(member: GuildMember): Promise<void> {
    const guild = member.guild
    const activity = describeMemberJoin(member)
    await sendMemberLog(guild, activity, 'members', this.client)
  }

  @listener({ event: Events.GuildMemberRemove })
  async onGuildMemberRemove(member: GuildMember): Promise<void> {
    const guild = member.guild
    const activity = describeMemberLeave(member)
    await sendMemberLog(guild, activity, 'members', this.client)
  }

  @listener({ event: Events.MessageReactionAdd })
  async onMessageReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ): Promise<void> {
    if (user.bot) return
    const partialReaction = reaction.partial
      ? await reaction.fetch().catch(() => null)
      : reaction
    if (partialReaction === null) {
      logger.warn('ServerLog', 'reaction fetch 실패')
      return
    }
    const fullUser = user.partial ? await user.fetch().catch(() => null) : user
    if (fullUser === null) return

    const message = partialReaction.message
    if (message.guildId === null) {
      logger.warn('ServerLog', 'guildId가 null')
      return
    }

    const guild = message.client.guilds.cache.get(message.guildId)
    if (guild === undefined) {
      logger.warn('ServerLog', `guild ${message.guildId} 캐시에 없음`)
      return
    }

    const activity = await describeReactionAdd(partialReaction, fullUser)
    if (activity === null) return

    await sendReactionLog(guild, activity, 'expressions', this.client)
  }

  @listener({ event: Events.MessageReactionRemove })
  async onMessageReactionRemove(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ): Promise<void> {
    if (user.bot) return
    const partialReaction = reaction.partial
      ? await reaction.fetch().catch(() => null)
      : reaction
    if (partialReaction === null) return
    const fullUser = user.partial ? await user.fetch().catch(() => null) : user
    if (fullUser === null) return

    const message = partialReaction.message
    if (message.guildId === null) return

    const guild = message.client.guilds.cache.get(message.guildId)
    if (guild === undefined) return

    const activity = await describeReactionRemove(partialReaction, fullUser)
    if (activity === null) return

    await sendReactionLog(guild, activity, 'expressions', this.client)
  }
}

async function sendMessageLog(
  guild: Guild,
  activity: MessageActivity,
  category: ServerLogCategory,
  client: Client
): Promise<void> {
  const settings = await getServerLogSettings(guild.id)
  if (!settings.enabled) return

  const channelId = settings.categoryChannels[category]
  if (channelId === null || channelId === undefined) return

  const logChannel = guild.channels.cache.get(channelId)
  if (!isSendableLogChannel(logChannel)) return

  try {
    await logChannel.send({
      allowedMentions: { parse: [] },
      components: [buildMessageLogMessage(activity, category, guild, client)],
      flags: MessageFlags.IsComponentsV2,
    })
  } catch (err) {
    logger.error(
      'ServerLog',
      `메시지 로그 전송 실패: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

async function sendMemberLog(
  guild: Guild,
  activity: MemberActivity,
  category: ServerLogCategory,
  client: Client
): Promise<void> {
  const settings = await getServerLogSettings(guild.id)
  if (!settings.enabled) return

  const channelId = settings.categoryChannels[category]
  if (channelId === null || channelId === undefined) return

  const logChannel = guild.channels.cache.get(channelId)
  if (!isSendableLogChannel(logChannel)) return

  try {
    await logChannel.send({
      allowedMentions: { parse: [] },
      components: [buildMemberLogMessage(activity, category, guild, client)],
      flags: MessageFlags.IsComponentsV2,
    })
  } catch (err) {
    logger.error(
      'ServerLog',
      `멤버 로그 전송 실패: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

async function sendReactionLog(
  guild: Guild,
  activity: ReactionActivity,
  category: ServerLogCategory,
  client: Client
): Promise<void> {
  const settings = await getServerLogSettings(guild.id)
  if (!settings.enabled) return

  const channelId = settings.categoryChannels[category]
  if (channelId === null || channelId === undefined) return

  const logChannel = guild.channels.cache.get(channelId)
  if (!isSendableLogChannel(logChannel)) return

  try {
    await logChannel.send({
      allowedMentions: { parse: [] },
      components: [buildReactionLogMessage(activity, category, guild, client)],
      flags: MessageFlags.IsComponentsV2,
    })
  } catch (err) {
    logger.error(
      'ServerLog',
      `반응 로그 전송 실패: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

type InteractionResult =
  | {
      readonly kind: 'update'
      readonly settings: ReturnType<typeof getDraftServerLogSettings>
      readonly page: number
    }
  | {
      readonly kind: 'saved'
      readonly settings: ServerLogSettings
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
    return { kind: 'saved', settings }
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
