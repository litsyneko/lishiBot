import {
  ChannelType,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type User,
  type VoiceState,
} from 'discord.js'

const MAX_CONTENT_LENGTH = 1900
const MAX_DIFF_LENGTH = 900

export type VoiceActivity = {
  readonly kind:
    | 'join'
    | 'leave'
    | 'move'
    | 'mute'
    | 'unmute'
    | 'deafen'
    | 'undeafen'
  readonly channelId: string | null
  readonly fromChannelId: string | null
  readonly memberTag: string
  readonly memberId: string
}

export type MessageActivity = {
  readonly kind: 'edit' | 'delete' | 'bulkDelete'
  readonly channelId: string
  readonly authorId: string | null
  readonly authorTag: string | null
  readonly messageId: string
  readonly oldContent: string | null
  readonly newContent: string | null
  readonly count: number | null
}

export function detectVoiceActivity(
  oldState: VoiceState,
  newState: VoiceState
): VoiceActivity | null {
  const member = newState.member ?? oldState.member
  const memberId = newState.id
  const memberTag = member?.user.tag ?? memberId

  const oldChannel = oldState.channelId
  const newChannel = newState.channelId

  if (oldChannel === null && newChannel !== null) {
    return {
      channelId: newChannel,
      fromChannelId: null,
      kind: 'join',
      memberId,
      memberTag,
    }
  }

  if (oldChannel !== null && newChannel === null) {
    return {
      channelId: oldChannel,
      fromChannelId: null,
      kind: 'leave',
      memberId,
      memberTag,
    }
  }

  if (oldChannel !== null && newChannel !== null && oldChannel !== newChannel) {
    return {
      channelId: newChannel,
      fromChannelId: oldChannel,
      kind: 'move',
      memberId,
      memberTag,
    }
  }

  const oldMute = oldState.serverMute || oldState.mute
  const newMute = newState.serverMute || newState.mute
  if (!oldMute && newMute) {
    return {
      channelId: newChannel,
      fromChannelId: null,
      kind: 'mute',
      memberId,
      memberTag,
    }
  }
  if (oldMute && !newMute) {
    return {
      channelId: newChannel,
      fromChannelId: null,
      kind: 'unmute',
      memberId,
      memberTag,
    }
  }

  const oldDeaf = oldState.serverDeaf || oldState.deaf
  const newDeaf = newState.serverDeaf || newState.deaf
  if (!oldDeaf && newDeaf) {
    return {
      channelId: newChannel,
      fromChannelId: null,
      kind: 'deafen',
      memberId,
      memberTag,
    }
  }
  if (oldDeaf && !newDeaf) {
    return {
      channelId: newChannel,
      fromChannelId: null,
      kind: 'undeafen',
      memberId,
      memberTag,
    }
  }

  return null
}

export function describeVoiceActivity(activity: VoiceActivity): string {
  const channel =
    activity.channelId !== null ? `<#${activity.channelId}>` : '알 수 없음'

  switch (activity.kind) {
    case 'join':
      return `${activity.memberTag}님이 ${channel}에 참가했어요.`
    case 'leave':
      return `${activity.memberTag}님이 ${channel}에서 퇴장했어요.`
    case 'move':
      return `${activity.memberTag}님이 ${
        activity.fromChannelId !== null
          ? `<#${activity.fromChannelId}>`
          : '알 수 없음'
      }에서 ${channel}(으)로 이동했어요.`
    case 'mute':
      return `${activity.memberTag}님이 ${channel}에서 음소거됐어요.`
    case 'unmute':
      return `${activity.memberTag}님이 ${channel}에서 음소거 해제됐어요.`
    case 'deafen':
      return `${activity.memberTag}님이 ${channel}에서 청각 차단됐어요.`
    case 'undeafen':
      return `${activity.memberTag}님이 ${channel}에서 청각 차단 해제됐어요.`
  }
}

export function describeMessageEdit(
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage
): MessageActivity {
  return {
    authorId: oldMessage.author?.id ?? null,
    authorTag: oldMessage.author?.tag ?? null,
    channelId: oldMessage.channelId,
    count: null,
    kind: 'edit',
    messageId: oldMessage.id,
    newContent: newMessage.content ?? null,
    oldContent: oldMessage.content ?? null,
  }
}

export function describeMessageDelete(
  message: Message | PartialMessage
): MessageActivity {
  return {
    authorId: message.author?.id ?? null,
    authorTag: message.author?.tag ?? null,
    channelId: message.channelId,
    count: null,
    kind: 'delete',
    messageId: message.id,
    newContent: null,
    oldContent: message.content ?? null,
  }
}

export function describeBulkDelete(
  channel: GuildBasedChannel,
  count: number
): MessageActivity {
  return {
    authorId: null,
    authorTag: null,
    channelId: channel.id,
    count,
    kind: 'bulkDelete',
    messageId: 'bulk',
    newContent: null,
    oldContent: null,
  }
}

export function formatMessageContent(content: string | null): string {
  if (content === null || content.length === 0) return '*(내용 없음)*'
  const trimmed =
    content.length > MAX_CONTENT_LENGTH
      ? content.slice(0, MAX_CONTENT_LENGTH) + '…'
      : content
  return `\`\`\`\n${trimmed}\n\`\`\``
}

export function formatMessageDiff(
  oldContent: string | null,
  newContent: string | null
): string {
  const oldText = oldContent ?? ''
  const newText = newContent ?? ''

  const oldBlock =
    oldText.length > MAX_DIFF_LENGTH
      ? oldText.slice(0, MAX_DIFF_LENGTH) + '…'
      : oldText
  const newBlock =
    newText.length > MAX_DIFF_LENGTH
      ? newText.slice(0, MAX_DIFF_LENGTH) + '…'
      : newText

  return `**수정 전**\n\`\`\`\n${
    oldBlock || '(내용 없음)'
  }\n\`\`\`\n**수정 후**\n\`\`\`\n${newBlock || '(내용 없음)'}\n\`\`\``
}

export function resolveMessageChannel(guild: Guild, channelId: string): string {
  const channel = guild.channels.cache.get(channelId)
  if (channel === undefined) return channelId
  if (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement
  ) {
    return `<#${channelId}>`
  }
  return channel.name
}

export type MemberActivity = {
  readonly kind: 'join' | 'leave'
  readonly memberId: string
  readonly memberTag: string
  readonly accountAge: string | null
  readonly joinedServerAt: string | null
  readonly roles: readonly string[]
}

export function describeMemberJoin(member: GuildMember): MemberActivity {
  const user = member.user
  const accountAge = formatDiscordTimestamp(user.createdTimestamp)
  const joinedServerAt = formatDiscordTimestamp(member.joinedTimestamp)
  const roles = [...member.roles.cache.values()]
    .filter((role) => role.id !== member.guild.id)
    .map((role) => role.id)

  return {
    accountAge,
    joinedServerAt,
    kind: 'join',
    memberId: user.id,
    memberTag: user.tag,
    roles,
  }
}

export function describeMemberLeave(member: GuildMember): MemberActivity {
  const user = member.user
  const accountAge = formatDiscordTimestamp(user.createdTimestamp)
  const joinedServerAt =
    member.joinedTimestamp !== null
      ? formatDiscordTimestamp(member.joinedTimestamp)
      : null
  const roles = [...member.roles.cache.values()]
    .filter((role) => role.id !== member.guild.id)
    .map((role) => role.id)

  return {
    accountAge,
    joinedServerAt,
    kind: 'leave',
    memberId: user.id,
    memberTag: user.tag,
    roles,
  }
}

function formatDiscordTimestamp(timestamp: number | null): string | null {
  if (timestamp === null) return null
  return `<t:${Math.floor(timestamp / 1000)}:R>`
}

export type ReactionActivity = {
  readonly kind: 'add' | 'remove'
  readonly channelId: string
  readonly messageId: string
  readonly userId: string
  readonly userTag: string
  readonly emoji: string
}

export async function describeReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User
): Promise<ReactionActivity | null> {
  if (reaction.message.guildId === null) return null

  return {
    channelId: reaction.message.channelId,
    emoji: formatEmoji(reaction.emoji),
    kind: 'add',
    messageId: reaction.message.id,
    userTag: user.tag,
    userId: user.id,
  }
}

export async function describeReactionRemove(
  reaction: MessageReaction | PartialMessageReaction,
  user: User
): Promise<ReactionActivity | null> {
  if (reaction.message.guildId === null) return null

  return {
    channelId: reaction.message.channelId,
    emoji: formatEmoji(reaction.emoji),
    kind: 'remove',
    messageId: reaction.message.id,
    userTag: user.tag,
    userId: user.id,
  }
}

function formatEmoji(emoji: MessageReaction['emoji']): string {
  if (emoji.id !== null) {
    return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`
  }
  return emoji.name ?? '?'
}
