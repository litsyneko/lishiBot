import { Client, GuildMember } from 'discord.js'
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../toolTypes'
import { resolveGuild } from '../helpers/resolveGuild'

function formatMemberInfo(member: GuildMember): Record<string, unknown> {
  return {
    id: member.id,
    tag: member.user.tag,
    displayName: member.displayName,
    joinedAt: member.joinedAt?.toISOString() ?? null,
    createdAt: member.user.createdAt.toISOString(),
    roles: member.roles.cache
      .filter((r) => r.id !== r.guild.id)
      .map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
    isOwner: member.guild.ownerId === member.id,
  }
}

function summarizeMember(member: GuildMember): string {
  const parts = [
    `닉네임: ${member.displayName}`,
    `태그: ${member.user.tag}`,
    member.guild.ownerId === member.id ? '서버 주인' : '',
    `역할: ${member.roles.cache.filter((r) => r.id !== r.guild.id).map((r) => r.name).join(', ') || '없음'}`,
  ].filter(Boolean)
  return parts.join('\n')
}

function matchMember(member: GuildMember, query: string): boolean {
  const lower = query.toLowerCase()
  return (
    member.id === query ||
    member.user.id === query ||
    member.user.tag.toLowerCase() === lower ||
    member.user.username.toLowerCase() === lower ||
    member.displayName.toLowerCase() === lower
  )
}

export function lookupMemberTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'lookup_member',
      description:
        '서버 멤버를 조회합니다. 이름이나 ID로 특정 멤버를 찾거나, query 없이 전체 멤버 목록(최대 20명)을 불러와요. 각 멤버의 닉네임, 역할, 가입일 등을 확인할 수 있어요.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              '검색할 멤버의 ID, 태그, 유저명 또는 표시 이름. 비우면 전체 멤버 목록을 반환해요.',
          },
          limit: {
            type: 'integer',
            description:
              '반환할 최대 멤버 수 (1~50, 기본값 10, query 없을 때만 적용)',
          },
        },
        required: [],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'info',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      try {
        const query = args.query as string | undefined
        const guild = await resolveGuild(client, context)
        const members = await guild.members.fetch()

        if (query && typeof query === 'string' && query.trim().length > 0) {
          const q = query.trim()
          const matched = members.find((m) => matchMember(m, q))
          if (!matched) {
            return { success: false, message: `해당 멤버를 찾을 수 없어요: ${q}` }
          }
          return {
            success: true,
            message: `${matched.displayName} 님의 정보를 찾았어요.`,
            data: formatMemberInfo(matched),
            summary: summarizeMember(matched),
          }
        }

        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50)
        const list = [...members.values()].slice(0, limit)
        return {
          success: true,
          message: `서버 멤버 ${list.length}명의 정보를 불러왔어요.`,
          data: { count: list.length, members: list.map(formatMemberInfo) },
          summary: list.map(summarizeMember).join('\n---\n'),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `멤버 조회 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
