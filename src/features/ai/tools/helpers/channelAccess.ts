import {
  Client,
  type GuildTextBasedChannel,
  PermissionFlagsBits,
} from 'discord.js'

export type ChannelAccess =
  | { readonly ok: true; readonly channel: GuildTextBasedChannel }
  | { readonly ok: false; readonly reason: string }

/**
 * 요청자(userId)가 실제로 접근(ViewChannel)할 수 있는 길드 텍스트 채널만 반환한다.
 * L3 권한 체크는 서버 레벨 권한만 보므로, 임의 channel_id로 요청자가 못 보는
 * 채널을 조작하는 것을 여기서 막는다(채널 단위 권한 우회 방지).
 */
export async function resolveAccessibleChannel(
  client: Client,
  userId: string,
  channelId: string
): Promise<ChannelAccess> {
  const channel = client.channels.cache.get(channelId)
  if (channel === undefined || !channel.isTextBased() || channel.isDMBased()) {
    return { ok: false, reason: '채널을 찾을 수 없어요.' }
  }
  const textChannel = channel as GuildTextBasedChannel
  const member = await textChannel.guild.members.fetch(userId).catch(() => null)
  if (member === null) {
    return { ok: false, reason: '요청자를 이 서버에서 찾을 수 없어요.' }
  }
  const perms = textChannel.permissionsFor(member)
  if (perms === null || !perms.has(PermissionFlagsBits.ViewChannel)) {
    return { ok: false, reason: '요청하신 분이 접근할 수 없는 채널이에요.' }
  }
  return { ok: true, channel: textChannel }
}
