import {
  primeGuildInvites,
  resolveJoinInvite,
  trackInviteCreate,
  trackInviteDelete,
} from '../features/serverLogs/inviteTracker'
import {
  SERVER_LOG_CATEGORIES,
  type ServerLogCategory,
  categoryForAuditAction,
  isServerLogCategory,
} from '../features/serverLogs/serverLogCategories'
import {
  type SendableLogChannel,
  enqueueServerLog,
} from '../features/serverLogs/serverLogDispatcher'
import {
  describeBulkDelete,
  describeMemberJoin,
  describeMemberLeave,
  describeMessageDelete,
  describeMessageEdit,
  describeReactionAdd,
  describeReactionClearAll,
  describeReactionClearEmoji,
  describeReactionRemove,
  detectVoiceActivity,
  hasLoggableMessageEdit,
  recordDeleteAuditEntry,
  resolveMessageDeleter,
} from '../features/serverLogs/serverLogEvents'
import {
  buildBulkDeleteLogMessage,
  buildMemberLogMessage,
  buildMessageLogMessage,
  buildReactionClearLogMessage,
  buildReactionLogMessage,
  buildServerLogMessage,
  buildVoiceLogMessage,
} from '../features/serverLogs/serverLogMessage'
import {
  SERVER_LOG_COMPONENT_PREFIX,
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
import type { ClanTagLogEntry } from './ClanTagExtension'
import { Extension, applicationCommand, listener } from '@pikokr/command.ts'
import {
  ApplicationCommandType,
  AttachmentBuilder,
  ChatInputCommandInteraction,
  type Collection,
  ContainerBuilder,
  Events,
  Guild,
  GuildAuditLogsEntry,
  type GuildBasedChannel,
  type GuildMember,
  Interaction,
  type Invite,
  Message,
  MessageComponentInteraction,
  MessageFlags,
  type MessageReaction,
  NewsChannel,
  type PartialGuildMember,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  PermissionFlagsBits,
  TextChannel,
  TextDisplayBuilder,
  type User,
  VoiceState,
} from 'discord.js'

const SESSION_TIMEOUT_MS = 3 * 60 * 1000
const BULK_TRANSCRIPT_FILE_NAME = 'deleted-messages.txt'

type PanelSession = {
  readonly guildId: string
  timeoutHandle: NodeJS.Timeout
}

const panelSessions = new Map<string, PanelSession>()

// 목록 뷰에서 카테고리를 골랐을 때 편집 뷰로 전환하기 위한 임시 상태 (길드별)
const editingCategories = new Map<string, ServerLogCategory>()

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

    for (const guild of this.client.guilds.cache.values()) {
      void primeGuildInvites(guild)
    }
  }

  @listener({ event: Events.GuildCreate })
  async onGuildCreate(guild: Guild): Promise<void> {
    await primeGuildInvites(guild)
  }

  @listener({ event: Events.InviteCreate })
  async onInviteCreate(invite: Invite): Promise<void> {
    trackInviteCreate(invite)
  }

  @listener({ event: Events.InviteDelete })
  async onInviteDelete(invite: Invite): Promise<void> {
    trackInviteDelete(invite)
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
    await i.reply(buildServerLogPanel(draft, draftPending, i.guild.id, null))
    registerSession(i.guild.id, i)
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
      await interaction.update(
        buildSavedServerLogPanel(result.settings, guildId)
      )
      clearSession(guildId)
      return
    }

    await interaction.update(
      buildServerLogPanel(
        result.settings,
        hasDraft(guildId),
        guildId,
        editingCategories.get(guildId) ?? null
      )
    )
    refreshSession(guildId, interaction)
  }

  @listener({ event: 'guildAuditLogEntryCreate' })
  async onAuditLogEntry(
    entry: GuildAuditLogsEntry,
    guild: Guild
  ): Promise<void> {
    // MessageDelete 항목은 카테고리 매핑이 없어도 삭제자 귀속 캐시에 기록한다.
    recordDeleteAuditEntry(guild, entry)

    const category = categoryForAuditAction(entry.action)
    if (category === null) return

    try {
      const destination = await resolveLogDestination(guild, category)
      if (destination === null) return

      enqueueServerLog(
        destination.channel,
        buildServerLogMessage(entry, category, guild, this.client)
      )
    } catch (err) {
      logger.error(
        'ServerLog',
        `감사 로그 처리 실패: ${
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
    // 판정은 fetch 전 원본(raw) 이벤트 기준으로 해야 한다. fetch로 승격된
    // 메시지는 과거 편집의 edited_timestamp까지 실어와 오탐을 만든다.
    if (!hasLoggableMessageEdit(oldMessage, newMessage)) return

    const fullNew = newMessage.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage
    if (fullNew === null) return
    if (fullNew.guild === null) return
    if (fullNew.author.bot) return

    const guild = fullNew.guild
    const destination = await resolveLogDestination(guild, 'messages')
    if (destination === null) return
    if (
      isExcludedChannel(destination.settings, fullNew.channelId) ||
      isExcludedUser(destination.settings, fullNew.author.id) ||
      isExcludedMember(destination.settings, fullNew.member)
    ) {
      return
    }

    enqueueServerLog(
      destination.channel,
      buildMessageLogMessage(
        describeMessageEdit(oldMessage, fullNew),
        'messages',
        guild,
        this.client
      )
    )
  }

  @listener({ event: Events.MessageDelete })
  async onMessageDelete(message: Message | PartialMessage): Promise<void> {
    if (message.guild === null) return
    const guild = message.guild

    // 봇 자신의 하우스키핑(승인 카드 자동 제거 등)은 기록하지 않는다.
    const selfId = this.client.user?.id ?? null
    if (selfId !== null && message.author?.id === selfId) return

    const destination = await resolveLogDestination(guild, 'messages')
    if (destination === null) return
    if (
      isExcludedChannel(destination.settings, message.channelId) ||
      isExcludedUser(destination.settings, message.author?.id ?? null) ||
      isExcludedMember(destination.settings, message.member)
    ) {
      return
    }

    const attribution = await resolveMessageDeleter(guild, message, Date.now())

    enqueueServerLog(
      destination.channel,
      buildMessageLogMessage(
        describeMessageDelete(message, attribution),
        'messages',
        guild,
        this.client
      )
    )
  }

  @listener({ event: Events.MessageBulkDelete })
  async onMessageBulkDelete(
    messages: Collection<string, Message | PartialMessage>,
    channel: GuildBasedChannel
  ): Promise<void> {
    const guild = channel.guild
    if (guild === undefined) return

    const destination = await resolveLogDestination(guild, 'messages')
    if (destination === null) return
    if (isExcludedChannel(destination.settings, channel.id)) return

    const details = describeBulkDelete(channel, messages)
    const transcriptFileName =
      details.transcript !== null ? BULK_TRANSCRIPT_FILE_NAME : null

    const container = buildBulkDeleteLogMessage(
      details,
      'messages',
      guild,
      this.client,
      transcriptFileName
    )

    // 트랜스크립트 파일이 붙는 로그는 배칭하지 않고 바로 보낸다.
    try {
      await destination.channel.send({
        allowedMentions: { parse: [] },
        components: [container],
        files:
          details.transcript !== null && transcriptFileName !== null
            ? [
                new AttachmentBuilder(Buffer.from(details.transcript, 'utf8'), {
                  name: transcriptFileName,
                }),
              ]
            : [],
        flags: MessageFlags.IsComponentsV2,
      })
    } catch (err) {
      logger.error(
        'ServerLog',
        `일괄 삭제 로그 전송 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  @listener({ event: Events.VoiceStateUpdate })
  async onVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState
  ): Promise<void> {
    const guild = oldState.guild
    if (guild === undefined) return

    const activity = detectVoiceActivity(oldState, newState)
    if (activity === null) return

    const destination = await resolveLogDestination(guild, 'voice')
    if (destination === null) return
    if (
      isExcludedChannel(destination.settings, activity.channelId) ||
      isExcludedChannel(destination.settings, activity.fromChannelId) ||
      isExcludedUser(destination.settings, activity.memberId) ||
      isExcludedMember(destination.settings, newState.member)
    ) {
      return
    }

    enqueueServerLog(
      destination.channel,
      buildVoiceLogMessage(activity, 'voice', guild, this.client)
    )
  }

  @listener({ event: Events.GuildMemberAdd })
  async onGuildMemberAdd(member: GuildMember): Promise<void> {
    const guild = member.guild
    // 로그가 꺼져 있어도 초대 사용량 캐시는 최신으로 유지해야
    // 나중에 켰을 때 엉뚱한 초대로 귀속되지 않는다.
    const invite = await resolveJoinInvite(guild)

    const destination = await resolveLogDestination(guild, 'members')
    if (destination === null) return
    if (isExcludedUser(destination.settings, member.id)) return

    enqueueServerLog(
      destination.channel,
      buildMemberLogMessage(
        describeMemberJoin(member, invite),
        'members',
        guild,
        this.client
      )
    )
  }

  @listener({ event: Events.GuildMemberRemove })
  async onGuildMemberRemove(
    member: GuildMember | PartialGuildMember
  ): Promise<void> {
    const guild = member.guild
    const destination = await resolveLogDestination(guild, 'members')
    if (destination === null) return
    if (
      isExcludedUser(destination.settings, member.id) ||
      isExcludedMember(destination.settings, member)
    ) {
      return
    }

    enqueueServerLog(
      destination.channel,
      buildMemberLogMessage(
        describeMemberLeave(member),
        'members',
        guild,
        this.client
      )
    )
  }

  @listener({ event: Events.MessageReactionAdd })
  async onMessageReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ): Promise<void> {
    if (user.bot === true) return
    const fullReaction = reaction.partial
      ? await reaction.fetch().catch(() => null)
      : reaction
    if (fullReaction === null) return
    const fullUser = user.partial ? await user.fetch().catch(() => null) : user
    if (fullUser === null) return

    const message = fullReaction.message
    if (message.guildId === null) return

    const guild = message.client.guilds.cache.get(message.guildId)
    if (guild === undefined) return

    const activity = await describeReactionAdd(fullReaction, fullUser)
    if (activity === null) return

    await this.sendReactionActivity(
      guild,
      activity.channelId,
      fullUser.id,
      () => buildReactionLogMessage(activity, 'expressions', guild, this.client)
    )
  }

  @listener({ event: Events.MessageReactionRemove })
  async onMessageReactionRemove(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ): Promise<void> {
    if (user.bot === true) return
    const fullReaction = reaction.partial
      ? await reaction.fetch().catch(() => null)
      : reaction
    if (fullReaction === null) return
    const fullUser = user.partial ? await user.fetch().catch(() => null) : user
    if (fullUser === null) return

    const message = fullReaction.message
    if (message.guildId === null) return

    const guild = message.client.guilds.cache.get(message.guildId)
    if (guild === undefined) return

    const activity = await describeReactionRemove(fullReaction, fullUser)
    if (activity === null) return

    await this.sendReactionActivity(
      guild,
      activity.channelId,
      fullUser.id,
      () => buildReactionLogMessage(activity, 'expressions', guild, this.client)
    )
  }

  @listener({ event: Events.MessageReactionRemoveAll })
  async onMessageReactionRemoveAll(
    message: Message | PartialMessage,
    reactions: Collection<string, MessageReaction>
  ): Promise<void> {
    if (message.guildId === null) return
    const guild = message.client.guilds.cache.get(message.guildId)
    if (guild === undefined) return

    const activity = describeReactionClearAll(message, reactions)
    await this.sendReactionActivity(guild, activity.channelId, null, () =>
      buildReactionClearLogMessage(activity, 'expressions', guild, this.client)
    )
  }

  @listener({ event: Events.MessageReactionRemoveEmoji })
  async onMessageReactionRemoveEmoji(
    reaction: MessageReaction | PartialMessageReaction
  ): Promise<void> {
    const message = reaction.message
    if (message.guildId === null) return
    const guild = message.client.guilds.cache.get(message.guildId)
    if (guild === undefined) return

    const activity = describeReactionClearEmoji(reaction)
    await this.sendReactionActivity(guild, activity.channelId, null, () =>
      buildReactionClearLogMessage(activity, 'expressions', guild, this.client)
    )
  }

  private async sendReactionActivity(
    guild: Guild,
    channelId: string,
    userId: string | null,
    build: () => ContainerBuilder
  ): Promise<void> {
    const destination = await resolveLogDestination(guild, 'expressions')
    if (destination === null) return
    if (
      isExcludedChannel(destination.settings, channelId) ||
      isExcludedUser(destination.settings, userId)
    ) {
      return
    }

    enqueueServerLog(destination.channel, build())
  }

  @listener({ event: 'clanTagChange' as never })
  async onClanTagChange(entry: ClanTagLogEntry): Promise<void> {
    const guild = entry.member.guild
    const destination = await resolveLogDestination(guild, 'clantag')
    if (destination === null) return

    const tagLabel =
      entry.action === 'added'
        ? `서버 태그 적용: **${entry.newTag ?? '알 수 없음'}**`
        : `서버 태그 해제${entry.oldTag ? ` (이전: **${entry.oldTag}**)` : ''}`

    const timestamp = `<t:${Math.floor(Date.now() / 1000)}:F>`

    enqueueServerLog(
      destination.channel,
      new ContainerBuilder()
        .setAccentColor(entry.action === 'added' ? 0x2ecc71 : 0xe74c3c)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### 🏷️ 서버 태그 변경\n${entry.member.toString()} (${
              entry.member.user.tag
            })\n${tagLabel}\n-# ${timestamp}`
          )
        )
    )
  }
}

type LogDestination = {
  readonly channel: SendableLogChannel
  readonly settings: ServerLogSettings
}

async function resolveLogDestination(
  guild: Guild,
  category: ServerLogCategory
): Promise<LogDestination | null> {
  const settings = await getServerLogSettings(guild.id)
  if (!settings.enabled) return null

  const channelId = settings.categoryChannels[category]
  if (channelId === null || channelId === undefined) return null

  const channel = guild.channels.cache.get(channelId)
  if (!isSendableLogChannel(channel)) return null

  return { channel, settings }
}

function isExcludedChannel(
  settings: ServerLogSettings,
  channelId: string | null
): boolean {
  if (channelId === null) return false
  return settings.exclusions.channels.includes(channelId)
}

function isExcludedUser(
  settings: ServerLogSettings,
  userId: string | null
): boolean {
  if (userId === null) return false
  return settings.exclusions.users.includes(userId)
}

function isExcludedMember(
  settings: ServerLogSettings,
  member: GuildMember | PartialGuildMember | null
): boolean {
  if (member === null) return false
  if (settings.exclusions.roles.length === 0) return false
  return settings.exclusions.roles.some((roleId) =>
    member.roles.cache.has(roleId)
  )
}

type InteractionResult =
  | {
      readonly kind: 'update'
      readonly settings: ReturnType<typeof getDraftServerLogSettings>
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

  // 목록 뷰에서 카테고리 선택 → 해당 카테고리의 채널 셀렉트 편집 뷰로 전환
  if (interaction.isStringSelectMenu() && action === 'pick') {
    const category = interaction.values[0]
    if (category === undefined || !isServerLogCategory(category)) {
      return { kind: 'update', settings: getDraftServerLogSettings(guildId) }
    }
    editingCategories.set(guildId, category)
    return { kind: 'update', settings: getDraftServerLogSettings(guildId) }
  }

  if (interaction.isButton() && action === 'back') {
    editingCategories.delete(guildId)
    return { kind: 'update', settings: getDraftServerLogSettings(guildId) }
  }

  if (interaction.isChannelSelectMenu() && action.startsWith('cat:')) {
    const category = action.slice('cat:'.length)
    if (!isServerLogCategory(category)) {
      return { kind: 'update', settings: getDraftServerLogSettings(guildId) }
    }

    const selectedId = interaction.values[0]
    const channelId = selectedId === undefined ? null : selectedId

    // 채널을 지정했을 때만 자동으로 활성화한다. 해제는 상태를 바꾸지 않는다.
    // 채널을 골랐으면 편집 뷰를 닫고 목록 뷰로 돌아간다.
    const settings = updateDraft(guildId, {
      categoryChannels: { [category]: channelId },
      ...(channelId !== null ? { enabled: true } : {}),
    })
    editingCategories.delete(guildId)
    return { kind: 'update', settings }
  }

  if (interaction.isChannelSelectMenu() && action === 'ignore:channels') {
    const settings = updateDraft(guildId, {
      exclusions: { channels: [...interaction.values] },
    })
    return { kind: 'update', settings }
  }

  if (interaction.isUserSelectMenu() && action === 'ignore:users') {
    const settings = updateDraft(guildId, {
      exclusions: { users: [...interaction.values] },
    })
    return { kind: 'update', settings }
  }

  if (interaction.isRoleSelectMenu() && action === 'ignore:roles') {
    const settings = updateDraft(guildId, {
      exclusions: { roles: [...interaction.values] },
    })
    return { kind: 'update', settings }
  }

  if (interaction.isButton() && action === 'toggle') {
    const current = getDraftServerLogSettings(guildId)
    const settings = updateDraft(guildId, { enabled: !current.enabled })
    return { kind: 'update', settings }
  }

  if (interaction.isButton() && action === 'clear') {
    const settings = updateDraft(guildId, {
      categoryChannels: emptyCategoryChannelMap(),
    })
    return { kind: 'update', settings }
  }

  if (interaction.isButton() && action === 'save') {
    editingCategories.delete(guildId)
    const settings = await commitDraft(guildId)
    return { kind: 'saved', settings }
  }

  if (interaction.isButton() && action === 'cancel') {
    editingCategories.delete(guildId)
    discardDraft(guildId)
    return { kind: 'cancelled' }
  }

  return { kind: 'update', settings: getDraftServerLogSettings(guildId) }
}

function registerSession(
  guildId: string,
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
  panelSessions.set(guildId, { guildId, timeoutHandle: handle })
}

function refreshSession(
  guildId: string,
  source: MessageComponentInteraction
): void {
  registerSession(guildId, source)
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
  editingCategories.delete(guildId)

  const draftPending = hasDraft(guildId)
  if (draftPending) {
    const settings = await commitDraft(guildId)
    await applyExpiredPanel(
      source,
      buildExpiredServerLogPanel(settings, guildId)
    )
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
  for (const category of SERVER_LOG_CATEGORIES) {
    result[category] = null
  }
  return result
}

export const setup = () => {
  return new ServerLogExtensionClass()
}
