import {
  executeModerationAction,
  isImmune,
  logModerationAction,
  notifyUser,
} from '../features/moderation/moderationActions'
import {
  SEVERITY_RANK,
  moderationConfig,
} from '../features/moderation/moderationConfig'
import { checkAllContentFilters } from '../features/moderation/moderationFilters'
import {
  getEffectiveImmuneRoles,
  getMinSeverity,
  isCategoryEnabled,
  isChannelExempt,
  isModerationEnabled,
  isTimeoutEnabled,
  loadModerationSettings,
} from '../features/moderation/moderationSettingsStore'
import {
  isCurrentlyTimedOut,
  recordMessage,
} from '../features/moderation/moderationSpamDetector'
import { getServerLogSettings } from '../features/serverLogs/serverLogSettings'
import { logger } from '../utils/logger'
import { Extension, listener } from '@pikokr/command.ts'
import {
  ContainerBuilder,
  Events,
  type Message,
  MessageFlags,
  type PartialMessage,
  TextDisplayBuilder,
} from 'discord.js'

const WARNING_EMOJI = '<:kawaiicaution:1521755658792206366>'

const CENSORED_CONTENT_LIMIT = 800

function formatTimeoutDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 1)}분`
  return `${Math.floor(minutes / 60)}시간${
    minutes % 60 > 0 ? ` ${minutes % 60}분` : ''
  }`
}

function timeoutDurationFor(severity: string): number | null {
  if (severity === 'low' || severity === 'medium' || severity === 'high') {
    return moderationConfig.timeoutDurationMs[severity]
  }
  return null
}

// 검열된 원문을 로그에 안전하게 표시한다. 코드블록으로 감싸 마크다운/멘션이
// 렌더링되지 않게 하고, 코드블록 이스케이프(```)를 무력화한다.
function formatCensoredContent(rawContent: string): string {
  const trimmed = rawContent.trim()
  if (trimmed.length === 0) {
    return '_(텍스트 없음 · 첨부/이미지)_'
  }

  const truncated = rawContent.length > CENSORED_CONTENT_LIMIT
  const sliced = rawContent.slice(0, CENSORED_CONTENT_LIMIT)
  const safe = sliced.replace(/```/gu, '`​`​`')

  return `\`\`\`\n${safe}${truncated ? '\n…(생략)' : ''}\n\`\`\``
}

const FILTER_EMOJI: Readonly<Record<string, string>> = {
  bannedWord: '🚫',
  cryptoSpam: '💰',
  externalUrl: '🔗',
  inviteLink: '📨',
  nsfw: '🔞',
  personalInfo: '🔐',
  spam: '📦',
}

type ModerationEntry = {
  readonly guild: { id: string; name: string }
  readonly message: Message
  readonly result: {
    readonly filter: string
    readonly reason: string
    readonly severity: string
  }
  readonly actions: { readonly deleted: boolean; readonly timedOut: boolean }
}

class ModerationExtensionClass extends Extension {
  @listener({ event: 'clientReady' })
  async onReady(): Promise<void> {
    await loadModerationSettings()
  }

  @listener({ event: 'messageCreate' })
  async onMessageCreate(message: Message): Promise<void> {
    await this.checkMessage(message)
  }

  @listener({ event: Events.MessageUpdate })
  async onMessageUpdate(
    oldMessage: Message | PartialMessage,
    newMessage: Message | PartialMessage
  ): Promise<void> {
    // 캐시에 없던(partial) 메시지는 원본 내용이 null이라 내용 비교가 항상
    // "변경됨"으로 오탐된다. 임베드 언퍼링/고정 등으로 과거 메시지가
    // 재검열되지 않도록, 실제 편집(edited_timestamp 갱신)만 처리한다.
    if (oldMessage.partial) {
      if (newMessage.editedTimestamp === null) return
    } else if (oldMessage.content === newMessage.content) {
      return
    }
    const fullMessage = newMessage.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage
    if (fullMessage === null) return
    await this.checkMessage(fullMessage)
  }

  private async checkMessage(message: Message): Promise<void> {
    if (message.author.bot) return
    if (message.guild === null) return

    const guildId = message.guild.id
    if (!isModerationEnabled(guildId)) return
    if (isChannelExempt(guildId, message.channel.id)) return

    const member = message.member
    if (member === null) return
    if (isImmune(member, getEffectiveImmuneRoles(guildId))) return

    if (isCurrentlyTimedOut(guildId, message.author.id)) {
      try {
        await message.delete()
      } catch {
        // already deleted
      }
      return
    }

    const content = message.content

    let result = checkAllContentFilters(content, (category) =>
      isCategoryEnabled(guildId, category)
    )

    if (result === null && isCategoryEnabled(guildId, 'spam')) {
      result = recordMessage({
        channelId: message.channel.id,
        content,
        guildId,
        messageId: message.id,
        userId: message.author.id,
      })
    }

    if (result === null) return

    // 설정된 최소 심각도 미만이면 조치하지 않는다.
    if (
      SEVERITY_RANK[result.severity] < SEVERITY_RANK[getMinSeverity(guildId)]
    ) {
      return
    }

    try {
      const actions = await executeModerationAction(
        message,
        result,
        isTimeoutEnabled(guildId)
      )
      const logEntry = await logModerationAction(
        message.guild,
        message,
        result,
        actions
      )
      await notifyUser(message, result, actions)
      await this.sendModerationLog(logEntry)
    } catch (err) {
      logger.error(
        'Moderation',
        `검열 처리 중 오류: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private async sendModerationLog(entry: ModerationEntry): Promise<void> {
    try {
      const settings = await getServerLogSettings(entry.guild.id)
      if (!settings.enabled) return

      const channelId = settings.categoryChannels.automod
      if (channelId === null || channelId === undefined) return

      const guild = this.client.guilds.cache.get(entry.guild.id)
      if (guild === undefined) return

      const channel = guild.channels.cache.get(channelId)
      if (channel === undefined || !('send' in channel)) return

      const emoji = FILTER_EMOJI[entry.result.filter] ?? '⚠️'
      const severityLabel =
        entry.result.severity === 'high'
          ? '🟥 높음'
          : entry.result.severity === 'medium'
          ? '🟨 중간'
          : '🟩 낮음'
      const messageTimestamp = entry.message.createdTimestamp
      const timeoutMs = timeoutDurationFor(entry.result.severity)

      const lines = [
        `### ${WARNING_EMOJI} ${emoji} 자동 검열 조치`,
        `**대상:** ${entry.message.author.toString()} (${
          entry.message.author.tag
        })`,
        `**사유:** ${entry.result.reason}`,
        `**심각도:** ${severityLabel}`,
        `**검열된 내용:**\n${formatCensoredContent(entry.message.content)}`,
        `**조치:** ${entry.actions.deleted ? '메시지 삭제' : '삭제 실패'} · ${
          entry.actions.timedOut
            ? `타임아웃 적용${
                timeoutMs !== null
                  ? ` (${formatTimeoutDuration(timeoutMs)})`
                  : ''
              }`
            : '타임아웃 미적용'
        }`,
        `-# 채널: <#${entry.message.channel.id}> · 메시지 ID: ${
          entry.message.id
        } · <t:${Math.floor(messageTimestamp / 1000)}:F>`,
      ]

      await channel.send({
        allowedMentions: { parse: [] },
        components: [
          new ContainerBuilder()
            .setAccentColor(0xe74c3c)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(lines.join('\n'))
            ),
        ],
        flags: MessageFlags.IsComponentsV2,
      })
    } catch (err) {
      logger.debug(
        'Moderation',
        `검열 로그 전송 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
}

export const setup = () => {
  return new ModerationExtensionClass()
}
