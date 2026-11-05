import type { ToolExecutionContext } from '../toolTypes'
import {
  ChannelType,
  type Client,
  type GuildTextBasedChannel,
  PermissionFlagsBits,
} from 'discord.js'

type MessageChannelAccess =
  | { readonly ok: true; readonly channel: GuildTextBasedChannel }
  | { readonly ok: false; readonly reason: string }

export async function resolveMessageChannelAccess(
  client: Client,
  context: ToolExecutionContext,
  channelId: string,
  permission: 'read' | 'send'
): Promise<MessageChannelAccess> {
  if (!context.guildId) {
    return { ok: false, reason: '개인 메시지에서는 이 작업을 할 수 없어요.' }
  }

  const guild = client.guilds.cache.get(context.guildId)
  if (!guild) {
    return { ok: false, reason: '요청한 서버를 찾을 수 없어요.' }
  }

  // 캐시의 채널/멤버 권한은 승인 대기 중 바뀔 수 있다. 실행 직전에 강제 조회한다.
  const [roles, channel, requester, bot] = await Promise.all([
    guild.roles.fetch().catch(() => null),
    guild.channels.fetch(channelId, { force: true }).catch(() => null),
    guild.members
      .fetch({ user: context.userId, force: true })
      .catch(() => null),
    guild.members
      .fetch({ user: client.user?.id ?? '', force: true })
      .catch(() => null),
  ])
  if (
    !channel ||
    channel.guildId !== context.guildId ||
    !channel.isTextBased() ||
    channel.isDMBased() ||
    !('send' in channel) ||
    !('messages' in channel)
  ) {
    return { ok: false, reason: '같은 서버의 텍스트 채널만 사용할 수 있어요.' }
  }
  if (!requester || !roles) {
    return { ok: false, reason: '요청자를 이 서버에서 찾을 수 없어요.' }
  }
  if (!bot) {
    return { ok: false, reason: '봇의 서버 권한을 확인할 수 없어요.' }
  }

  const required =
    permission === 'read'
      ? PermissionFlagsBits.ReadMessageHistory
      : channel.isThread()
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages
  const requesterPermissions = channel.permissionsFor(requester)
  if (
    !requesterPermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !requesterPermissions.has(required)
  ) {
    return { ok: false, reason: '요청자에게 대상 채널의 권한이 없어요.' }
  }
  const botPermissions = channel.permissionsFor(bot)
  if (
    !botPermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !botPermissions.has(required)
  ) {
    return { ok: false, reason: '봇에게 대상 채널의 권한이 없어요.' }
  }

  // discord.js ThreadChannel.permissionsFor는 부모 채널 권한만 반환한다.
  // 비공개 스레드는 별도의 멤버십이 필요하며, 공개 스레드는 참여 전에도 접근 가능하다.
  if (channel.isThread() && channel.type === ChannelType.PrivateThread) {
    const [requesterInThread, botInThread] = await Promise.all([
      channel.members
        .fetch({ member: requester.id, force: true })
        .catch(() => null),
      channel.members.fetch({ member: bot.id, force: true }).catch(() => null),
    ])
    if (
      !requesterInThread &&
      !requesterPermissions.has(PermissionFlagsBits.ManageThreads, false)
    ) {
      return { ok: false, reason: '요청자가 비공개 스레드의 멤버가 아니에요.' }
    }
    if (
      !botInThread &&
      !botPermissions.has(PermissionFlagsBits.ManageThreads, false)
    ) {
      return { ok: false, reason: '봇이 비공개 스레드의 멤버가 아니에요.' }
    }
  }

  if (
    permission === 'send' &&
    channel.isThread() &&
    channel.archived &&
    channel.locked &&
    !botPermissions.has(PermissionFlagsBits.ManageThreads)
  ) {
    return {
      ok: false,
      reason: '잠긴 보관 스레드에는 메시지를 보낼 수 없어요.',
    }
  }

  return { ok: true, channel: channel as GuildTextBasedChannel }
}
