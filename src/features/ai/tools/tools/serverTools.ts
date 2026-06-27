import { resolveGuild } from '../helpers/resolveGuild'
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../toolTypes'
import { Client } from 'discord.js'

// ─── getServerInfoTool ───

export function getServerInfoTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'get_server_info',
      description:
        '현재 서버의 정보를 불러옵니다. 이름, 멤버 수, 채널 수, 소유자, 생성일 등을 반환해요.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'info',
    },
    async execute(
      _args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const guild = await resolveGuild(client, context)

        const owner = await guild.fetchOwner().catch(() => null)
        const createdAt = guild.createdAt
        const createdAtStr = `${createdAt.getFullYear()}년 ${
          createdAt.getMonth() + 1
        }월 ${createdAt.getDate()}일`

        const memberCount = guild.memberCount
        const channelCount = guild.channels.cache.size

        const summary =
          `서버명: ${guild.name}\n` +
          `멤버: ${memberCount}명\n` +
          `채널: ${channelCount}개\n` +
          `소유자: ${owner ? owner.user.tag : '알 수 없음'}\n` +
          `생성일: ${createdAtStr}`

        return {
          success: true,
          message: summary,
          data: {
            id: guild.id,
            name: guild.name,
            memberCount,
            channelCount,
            ownerId: guild.ownerId,
            ownerTag: owner ? owner.user.tag : null,
            createdAt: createdAt.toISOString(),
            createdAtStr,
          },
          summary,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `서버 정보 불러오기 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
