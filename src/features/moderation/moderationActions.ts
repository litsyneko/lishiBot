import { logger } from '../../utils/logger'
import { type FilterResult, moderationConfig } from './moderationConfig'
import { getRecentMessageIds, markTimedOut } from './moderationSpamDetector'
import {
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type Message,
  PermissionFlagsBits,
} from 'discord.js'

const SPAM_DELETE_WINDOW_MS = 20_000
const WARNING_EMOJI = '<:kawaiicaution:1521755658792206366>'

export function isImmune(
  member: GuildMember,
  immuneRoleIds: readonly string[]
): boolean {
  // 메시지 관리 권한 보유자(모더레이터/관리자)는 검열 면제.
  // 다른 서버에서 검열을 켰을 때 관리자가 실수로 타임아웃되는 것을 방지한다.
  if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return true

  return immuneRoleIds.some((roleId) => member.roles.cache.has(roleId))
}

function severityTimeoutMs(severity: FilterResult['severity']): number {
  return moderationConfig.timeoutDurationMs[severity]
}

function reasonText(result: FilterResult): string {
  return `자동 검열: ${result.reason}`
}

export async function deleteMessage(message: Message): Promise<boolean> {
  try {
    await message.delete()
    return true
  } catch (err) {
    logger.debug(
      'Moderation',
      `메시지 삭제 실패: ${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}

async function deleteSpamMessages(message: Message): Promise<boolean> {
  if (message.guild === null) return deleteMessage(message)

  const recentMessages = getRecentMessageIds({
    guildId: message.guild.id,
    userId: message.author.id,
    windowMs: SPAM_DELETE_WINDOW_MS,
  })

  const channelMap = new Map<string, string[]>()
  for (const entry of recentMessages) {
    const ids = channelMap.get(entry.channelId) ?? []
    ids.push(entry.messageId)
    channelMap.set(entry.channelId, ids)
  }

  let deletedCount = 0
  for (const [channelId, messageIds] of channelMap) {
    const channel = message.client.channels.cache.get(channelId)
    if (channel === undefined || !channel.isTextBased()) continue
    if (!('bulkDelete' in channel)) continue

    try {
      const deleted = await channel.bulkDelete(messageIds, true)
      deletedCount += deleted.size
    } catch (err) {
      logger.debug(
        'Moderation',
        `스팸 메시지 일괄 삭제 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  return deletedCount > 0 || (await deleteMessage(message))
}

function shouldTimeout(result: FilterResult): boolean {
  return result.severity !== 'low'
}

function severityColor(severity: FilterResult['severity']): number {
  if (severity === 'high') return 0xe74c3c
  if (severity === 'medium') return 0xf39c12
  return 0x3498db
}

function buildNoticeEmbed(
  result: FilterResult,
  timedOut: boolean
): EmbedBuilder {
  const durationSec = Math.round(severityTimeoutMs(result.severity) / 1000)
  const actionText = timedOut
    ? `메시지 삭제 및 ${durationSec}초 타임아웃`
    : '메시지 삭제'

  return new EmbedBuilder()
    .setColor(severityColor(result.severity))
    .setTitle(`${WARNING_EMOJI} 자동 검열 안내`)
    .setDescription('메시지가 검열 기준에 따라 삭제되었어요.')
    .addFields(
      { name: '사유', value: result.reason },
      { name: '조치', value: actionText }
    )
    .setFooter({ text: '규칙을 확인해 주세요.' })
    .setTimestamp()
}

export async function applyTimeout(
  member: GuildMember | null,
  result: FilterResult
): Promise<boolean> {
  if (member === null) return false
  const duration = severityTimeoutMs(result.severity)
  try {
    await member.timeout(duration, reasonText(result))
    markTimedOut(member.guild.id, member.id, duration)
    return true
  } catch (err) {
    logger.debug(
      'Moderation',
      `타임아웃 실패: ${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}

async function sendChannelNotice(
  message: Message,
  result: FilterResult,
  timedOut: boolean
): Promise<void> {
  const channel = message.channel
  if (!('send' in channel)) return

  try {
    const sent = await channel.send({
      allowedMentions: { users: [message.author.id] },
      content: `<@${message.author.id}>`,
      embeds: [buildNoticeEmbed(result, timedOut)],
    })
    setTimeout(
      () => {
        sent.delete().catch(() => undefined)
      },
      timedOut ? severityTimeoutMs(result.severity) : 10_000
    )
  } catch (err) {
    logger.debug(
      'Moderation',
      `채널 안내 전송 실패: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export type ModerationActionResult = {
  readonly deleted: boolean
  readonly timedOut: boolean
}

export async function executeModerationAction(
  message: Message,
  result: FilterResult,
  timeoutEnabled: boolean
): Promise<ModerationActionResult> {
  const deleted =
    result.filter === 'spam'
      ? await deleteSpamMessages(message)
      : await deleteMessage(message)
  const timedOut =
    timeoutEnabled && shouldTimeout(result)
      ? await applyTimeout(message.member, result)
      : false

  if (deleted) {
    await sendChannelNotice(message, result, timedOut)
  }

  return { deleted, timedOut }
}

export async function notifyUser(
  message: Message,
  result: FilterResult,
  actions: ModerationActionResult
): Promise<void> {
  try {
    await message.author.send({
      embeds: [buildNoticeEmbed(result, actions.timedOut)],
    })
  } catch {
    // DM 차단 시 무시
  }
}

export type ModerationLogEntry = {
  readonly guild: Guild
  readonly message: Message
  readonly result: FilterResult
  readonly actions: ModerationActionResult
}

export function buildModerationLogEntry(
  guild: Guild,
  message: Message,
  result: FilterResult,
  actions: ModerationActionResult
): ModerationLogEntry {
  return { guild, message, result, actions }
}

export async function logModerationAction(
  guild: Guild,
  message: Message,
  result: FilterResult,
  actions: ModerationActionResult
): Promise<ModerationLogEntry> {
  logger.info(
    'Moderation',
    `${guild.name} - ${message.author.tag}: ${result.reason} ` +
      `[삭제=${actions.deleted}, 타임아웃=${actions.timedOut}, 심각도=${result.severity}]`
  )
  return buildModerationLogEntry(guild, message, result, actions)
}
