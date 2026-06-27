import { resolveGuild } from '../helpers/resolveGuild'
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../toolTypes'
import { Client, Role } from 'discord.js'

function formatRoleInfo(role: Role): Record<string, unknown> {
  return {
    id: role.id,
    name: role.name,
    color: role.hexColor,
    hoist: role.hoist,
    mentionable: role.mentionable,
    position: role.position,
    memberCount: role.members.size,
    permissions: role.permissions.toArray().slice(0, 15),
    createdAt: role.createdAt?.toISOString() ?? null,
  }
}

function summarizeRole(role: Role): string {
  return [
    `이름: ${role.name}`,
    `멤버: ${role.members.size}명`,
    role.hexColor !== '#000000' ? `색상: ${role.hexColor}` : '',
    role.mentionable ? '멘션 가능' : '',
  ]
    .filter(Boolean)
    .join(' | ')
}

// ─── listRolesTool ───

export function listRolesTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'list_roles',
      description:
        '서버의 모든 역할을 조회합니다. 각 역할의 이름, 색상, 멤버 수, 주요 권한을 확인할 수 있어요.',
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
        const roles = [...guild.roles.cache.values()]
          .filter((r) => r.id !== guild.id)
          .sort((a, b) => b.position - a.position)

        return {
          success: true,
          message: `서버에 ${roles.length}개의 역할이 있어요.`,
          data: { count: roles.length, roles: roles.map(formatRoleInfo) },
          summary: roles.map(summarizeRole).join('\n'),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `역할 목록 조회 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── lookupRoleTool ───

export function lookupRoleTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'lookup_role',
      description:
        '특정 역할의 상세 정보를 조회합니다. 역할 이름이나 ID로 검색할 수 있어요. 역할 색상, 권한, 소유 멤버 수 등을 확인할 수 있어요.',
      parameters: {
        type: 'object',
        properties: {
          roleId: {
            type: 'string',
            description: '조회할 역할의 ID',
          },
          roleName: {
            type: 'string',
            description: '조회할 역할의 이름 (roleId가 없을 때 사용)',
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
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const roleId = args.roleId as string | undefined
        const roleName = args.roleName as string | undefined

        if (!roleId && !roleName) {
          return {
            success: false,
            message: 'roleId 또는 roleName 중 하나는 필요해요.',
          }
        }

        const guild = await resolveGuild(client, context)

        let target: Role | undefined
        if (roleId) {
          target = guild.roles.cache.get(roleId)
        }
        if (!target && roleName) {
          const lower = roleName.toLowerCase()
          target = guild.roles.cache.find((r) => r.name.toLowerCase() === lower)
        }
        if (!target) {
          return { success: false, message: '해당 역할을 찾을 수 없어요.' }
        }

        return {
          success: true,
          message: `${target.name} 역할 정보를 찾았어요.`,
          data: formatRoleInfo(target),
          summary: summarizeRole(target),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `역할 조회 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
