import type { ToolExecutionContext } from '../toolTypes'
import { resolveGuild } from './resolveGuild'
import { type Client, PermissionFlagsBits, type Role } from 'discord.js'

// 역할 부여/회수의 위험도를 좌우하는 "관리 권한" 플래그.
// 이 중 하나라도 가진 역할은 부여/회수 시 승인 게이트(danger)를 거친다.
// 색깔 역할처럼 관리 권한이 없는 역할은 즉시 실행(warning)한다.
const SENSITIVE_ROLE_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageMessages,
] as const

// 역할이 관리 권한을 하나라도 포함하는지.
export function roleHasSensitivePermissions(role: Role): boolean {
  return SENSITIVE_ROLE_PERMISSIONS.some((flag) => role.permissions.has(flag))
}

// add_role_member / remove_role_member args에서 대상 역할을 캐시로 해석.
// 실패하면 null.
async function resolveRoleFromArgs(
  client: Client,
  context: ToolExecutionContext,
  args: Record<string, unknown>
): Promise<Role | null> {
  const roleId = (args.role_id as string | undefined)?.trim() || undefined
  const roleName = (args.role_name as string | undefined)?.trim() || undefined
  if (!roleId && !roleName) return null
  const guild = await resolveGuild(client, context).catch(() => null)
  if (guild === null) return null
  if (roleId) {
    const byId = guild.roles.cache.get(roleId)
    if (byId !== undefined) return byId
  }
  if (roleName) {
    const lower = roleName.toLowerCase()
    const byName = guild.roles.cache.find((r) => r.name.toLowerCase() === lower)
    if (byName !== undefined) return byName
  }
  return null
}

// 역할 부여/회수 대상이 승인 게이트를 거쳐야 하는지(관리 권한 포함 역할인지).
// 역할 해석 실패 시에도 true — 판정 불가는 안전하게 승인 쪽(fail-closed)으로 넘긴다.
export async function roleAssignmentIsSensitive(
  client: Client,
  context: ToolExecutionContext,
  args: Record<string, unknown>
): Promise<boolean> {
  const role = await resolveRoleFromArgs(client, context, args)
  if (role === null) return true
  return roleHasSensitivePermissions(role)
}
