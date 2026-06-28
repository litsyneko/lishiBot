import { resolveGuild } from '../helpers/resolveGuild'
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../toolTypes'
import { Client, type GuildMember, type Role } from 'discord.js'

/**
 * 리시(bot) 권한 계층 검사 — 대상 멤버가 리시보다 높거나 같으면 거부.
 * owner는 별도로 처리해야 함 (caller 책임).
 */
function assertBotCanActOn(
  member: GuildMember,
  botMember: GuildMember | null
): string | null {
  if (botMember === null) return null
  if (botMember.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    return '리시보다 권한이 높거나 같은 멤버에게는 작업할 수 없어요.'
  }
  return null
}

/**
 * 리시가 해당 역할을 멤버에게 부여/제거할 수 있는지 검사.
 * - 역할이 리시의 최상위 역할보다 높거나 같으면 거부
 * - 관리자 전용(managed) 역할은 거부 (봇/통합 연동 역할)
 * - @everyone 역할은 거부
 */
function assertBotCanAssignRole(
  role: Role,
  botMember: GuildMember | null
): string | null {
  if (role.id === role.guild.id) {
    return '@everyone 역할은 부여/제거할 수 없어요.'
  }
  if (role.managed) {
    return `${role.name}은(는) 연동/봇 전용 역할이라 직접 변경할 수 없어요.`
  }
  if (
    botMember !== null &&
    botMember.roles.highest.comparePositionTo(role) <= 0
  ) {
    return '리시보다 높거나 같은 위치의 역할은 다룰 수 없어요.'
  }
  return null
}

async function resolveRole(
  guildId: string,
  client: Client,
  context: ToolExecutionContext,
  roleId: string | undefined,
  roleName: string | undefined
): Promise<{ role?: Role; error?: string }> {
  if (!roleId && !roleName) {
    return { error: 'role_id 또는 role_name 중 하나는 필요해요.' }
  }
  const guild = await resolveGuild(client, context)
  let role: Role | undefined
  if (roleId) {
    role = guild.roles.cache.get(roleId)
  }
  if (!role && roleName) {
    const lower = roleName.toLowerCase()
    role = guild.roles.cache.find((r) => r.name.toLowerCase() === lower)
  }
  if (!role) {
    return { error: '해당 역할을 찾을 수 없어요.' }
  }
  return { role }
}

// ─── add_role_member ───

export function addRoleMemberTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'add_role_member',
      description:
        '멤버에게 역할을 부여합니다. 역할 ID 또는 이름으로 지정. 관리 역할이나 리시보다 높은 역할은 제외돼요.',
      parameters: {
        type: 'object',
        properties: {
          member_id: {
            type: 'string',
            description: '역할을 부여할 멤버 ID',
          },
          role_id: {
            type: 'string',
            description: '부여할 역할 ID (role_name이 없을 때 필요)',
          },
          role_name: {
            type: 'string',
            description: '부여할 역할 이름 (role_id가 없을 때 사용)',
          },
          reason: {
            type: 'string',
            description: '사유 (선택)',
          },
        },
        required: ['member_id'],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const memberId = (args.member_id as string | undefined)?.trim()
        const roleId = (args.role_id as string | undefined)?.trim() || undefined
        const roleName =
          (args.role_name as string | undefined)?.trim() || undefined
        const reason =
          (args.reason as string | undefined)?.trim() ?? 'AI 리시가 적용'

        if (!memberId) {
          return { success: false, message: '멤버 ID를 입력해 주세요.' }
        }

        const { role, error } = await resolveRole(
          '',
          client,
          context,
          roleId,
          roleName
        )
        if (error !== undefined || role === undefined) {
          return { success: false, message: error ?? '역할 오류' }
        }

        const guild = role.guild
        const member = await guild.members
          .fetch(memberId)
          .catch(() => undefined)
        if (member === undefined) {
          return { success: false, message: '멤버를 찾을 수 없어요.' }
        }

        if (guild.ownerId === member.id) {
          return {
            success: false,
            message: '서버 주인에게는 역할을 직접 부여할 수 없어요.',
          }
        }

        const botMember = guild.members.me
        const memberBlock = assertBotCanActOn(member, botMember)
        if (memberBlock !== null) {
          return { success: false, message: memberBlock }
        }
        const roleBlock = assertBotCanAssignRole(role, botMember)
        if (roleBlock !== null) {
          return { success: false, message: roleBlock }
        }

        if (member.roles.cache.has(role.id)) {
          return {
            success: false,
            message: `${member.displayName} 님은 이미 ${role.name} 역할을 가지고 있어요.`,
          }
        }

        await member.roles.add(role, reason)

        const summary = `${member.displayName} 님에게 **${role.name}** 역할을 부여했어요.`
        return {
          success: true,
          message: summary,
          summary,
          data: { memberId: member.id, roleId: role.id, roleName: role.name },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `역할 부여 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── remove_role_member ───

export function removeRoleMemberTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'remove_role_member',
      description:
        '멤버에게서 역할을 제거합니다. 역할 ID 또는 이름으로 지정. 관리 역할이나 리시보다 높은 역할은 제외돼요.',
      parameters: {
        type: 'object',
        properties: {
          member_id: {
            type: 'string',
            description: '역할을 제거할 멤버 ID',
          },
          role_id: {
            type: 'string',
            description: '제거할 역할 ID (role_name이 없을 때 필요)',
          },
          role_name: {
            type: 'string',
            description: '제거할 역할 이름 (role_id가 없을 때 사용)',
          },
          reason: {
            type: 'string',
            description: '사유 (선택)',
          },
        },
        required: ['member_id'],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const memberId = (args.member_id as string | undefined)?.trim()
        const roleId = (args.role_id as string | undefined)?.trim() || undefined
        const roleName =
          (args.role_name as string | undefined)?.trim() || undefined
        const reason =
          (args.reason as string | undefined)?.trim() ?? 'AI 리시가 적용'

        if (!memberId) {
          return { success: false, message: '멤버 ID를 입력해 주세요.' }
        }

        const { role, error } = await resolveRole(
          '',
          client,
          context,
          roleId,
          roleName
        )
        if (error !== undefined || role === undefined) {
          return { success: false, message: error ?? '역할 오류' }
        }

        const guild = role.guild
        const member = await guild.members
          .fetch(memberId)
          .catch(() => undefined)
        if (member === undefined) {
          return { success: false, message: '멤버를 찾을 수 없어요.' }
        }

        if (guild.ownerId === member.id) {
          return {
            success: false,
            message: '서버 주인에게는 역할을 직접 제거할 수 없어요.',
          }
        }

        const botMember = guild.members.me
        const memberBlock = assertBotCanActOn(member, botMember)
        if (memberBlock !== null) {
          return { success: false, message: memberBlock }
        }
        const roleBlock = assertBotCanAssignRole(role, botMember)
        if (roleBlock !== null) {
          return { success: false, message: roleBlock }
        }

        if (!member.roles.cache.has(role.id)) {
          return {
            success: false,
            message: `${member.displayName} 님은 ${role.name} 역할을 가지고 있지 않아요.`,
          }
        }

        await member.roles.remove(role, reason)

        const summary = `${member.displayName} 님에게서 **${role.name}** 역할을 제거했어요.`
        return {
          success: true,
          message: summary,
          summary,
          data: { memberId: member.id, roleId: role.id, roleName: role.name },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `역할 제거 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
