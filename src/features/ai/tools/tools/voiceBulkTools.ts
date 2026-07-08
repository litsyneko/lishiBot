import { resolveGuild } from '../helpers/resolveGuild'
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../toolTypes'
import { Client, type GuildMember } from 'discord.js'

interface BulkResult {
  moved: number
  skipped: number
  failed: number
  skippedReasons: string[]
}

function newResult(): BulkResult {
  return { moved: 0, skipped: 0, failed: 0, skippedReasons: [] }
}

/**
 * 리시가 이 멤버에게 음성 액션을 안전하게 적용할 수 있는지 검사.
 * - owner는 제외
 * - 리시보다 높거나 같은 권한의 멤버는 제외
 */
function canActOnMember(
  member: GuildMember,
  ownerId: string,
  botMember: GuildMember | null
): string | null {
  if (member.id === ownerId) return '서버 주인'
  if (member.user.bot) return '봇'
  if (botMember === null) return null
  if (botMember.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    return '리시보다 높거나 같은 권한'
  }
  return null
}

// ─── move_all_members ───

export function moveAllMembersTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'move_all_members',
      description:
        '특정 음성 채널에 있는 모든 멤버를 다른 음성 채널로 일괄 이동합니다. 서버 주인, 봇, 리시보다 높은 권한의 멤버는 건너뛰어요.',
      parameters: {
        type: 'object',
        properties: {
          source_channel_id: {
            type: 'string',
            description: '현재 음성 채널 ID',
          },
          target_channel_id: {
            type: 'string',
            description: '이동할 음성 채널 ID',
          },
          reason: {
            type: 'string',
            description: '사유 (선택)',
          },
        },
        required: ['source_channel_id', 'target_channel_id'],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'danger',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const sourceChannelId = (
          args.source_channel_id as string | undefined
        )?.trim()
        const targetChannelId = (
          args.target_channel_id as string | undefined
        )?.trim()
        const reason =
          (args.reason as string | undefined)?.trim() ?? 'AI 리시가 일괄 이동'

        if (!sourceChannelId || !targetChannelId) {
          return {
            success: false,
            message:
              'source_channel_id와 target_channel_id를 모두 입력해 주세요.',
          }
        }
        if (sourceChannelId === targetChannelId) {
          return {
            success: false,
            message: '출발 채널과 도착 채널이 같아요.',
          }
        }

        const guild = await resolveGuild(client, context)
        const sourceChannel = guild.channels.cache.get(sourceChannelId)
        const targetChannel = guild.channels.cache.get(targetChannelId)
        if (sourceChannel === undefined || !sourceChannel.isVoiceBased()) {
          return { success: false, message: '출발 음성 채널을 찾을 수 없어요.' }
        }
        if (targetChannel === undefined || !targetChannel.isVoiceBased()) {
          return { success: false, message: '도착 음성 채널을 찾을 수 없어요.' }
        }

        const members = [...sourceChannel.members.values()]
        if (members.length === 0) {
          return {
            success: false,
            message: '출발 채널에 멤버가 없어요.',
          }
        }

        const botMember = guild.members.me
        const result = newResult()
        for (const member of members) {
          const reasonToSkip = canActOnMember(member, guild.ownerId, botMember)
          if (reasonToSkip !== null) {
            result.skipped += 1
            result.skippedReasons.push(
              `${member.displayName} (${reasonToSkip})`
            )
            continue
          }
          try {
            await member.voice.setChannel(targetChannelId, reason)
            result.moved += 1
          } catch {
            result.failed += 1
          }
        }

        const summary = `${result.moved}명 이동 완료 (건너뜀 ${result.skipped}, 실패 ${result.failed}).`
        return {
          success: result.moved > 0,
          message: summary,
          summary,
          data: {
            sourceChannelId,
            targetChannelId,
            ...result,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `일괄 이동 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── disconnect_all_members ───

export function disconnectAllMembersTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'disconnect_all_members',
      description:
        '특정 음성 채널에 있는 모든 멤버를 음성에서 일괄 연결 해제(내보내기)합니다. 서버 주인, 봇, 리시보다 높은 권한의 멤버는 건너뛰어요.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: '비울 음성 채널 ID',
          },
          reason: {
            type: 'string',
            description: '사유 (선택)',
          },
        },
        required: ['channel_id'],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'danger',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const channelId = (args.channel_id as string | undefined)?.trim()
        const reason =
          (args.reason as string | undefined)?.trim() ??
          'AI 리시가 일괄 연결 해제'

        if (!channelId) {
          return { success: false, message: 'channel_id를 입력해 주세요.' }
        }

        const guild = await resolveGuild(client, context)
        const channel = guild.channels.cache.get(channelId)
        if (channel === undefined || !channel.isVoiceBased()) {
          return { success: false, message: '음성 채널을 찾을 수 없어요.' }
        }

        const members = [...channel.members.values()]
        if (members.length === 0) {
          return {
            success: false,
            message: '이 채널에 멤버가 없어요.',
          }
        }

        const botMember = guild.members.me
        const result = newResult()
        for (const member of members) {
          const reasonToSkip = canActOnMember(member, guild.ownerId, botMember)
          if (reasonToSkip !== null) {
            result.skipped += 1
            result.skippedReasons.push(
              `${member.displayName} (${reasonToSkip})`
            )
            continue
          }
          try {
            await member.voice.disconnect(reason)
            result.moved += 1
          } catch {
            result.failed += 1
          }
        }

        const summary = `${result.moved}명 연결 해제 (건너뜀 ${result.skipped}, 실패 ${result.failed}).`
        return {
          success: result.moved > 0,
          message: summary,
          summary,
          data: {
            channelId,
            ...result,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `일괄 연결 해제 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
