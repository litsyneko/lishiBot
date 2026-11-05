import type {
  PermissionCheckResult,
  ToolDefinition,
  ToolExecutionContext,
} from '../tools/toolTypes'
import { type Client, PermissionFlagsBits } from 'discord.js'

/**
 * Layer 3: Execution Gate Check
 * Called AFTER user confirms "네", right before execution.
 * Re-verifies base permissions AND runs runtime checks.
 */
export function checkToolPermissionLayer3(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  hasManageGuild: boolean,
  hasAdmin: boolean,
  hasManageChannels = false
): PermissionCheckResult {
  // L3a: re-verify base permissions (may have changed since proposal)
  if (definition.permission.requireAdmin && !hasAdmin) {
    return {
      ok: false,
      reason:
        '권한이 변경되어 이 작업을 더 이상 실행할 수 없어요. (관리자 권한 필요)',
    }
  }
  if (definition.permission.requireManageGuild && !hasManageGuild) {
    return {
      ok: false,
      reason:
        '권한이 변경되어 이 작업을 더 이상 실행할 수 없어요. (서버 관리 권한 필요)',
    }
  }

  if (definition.permission.requireManageChannels && !hasManageChannels) {
    return {
      ok: false,
      reason: '채널 관리 권한이 필요해요.',
    }
  }

  // L3b: runtime check (dynamic conditions like voice channel membership)
  if (definition.permission.runtimeCheck !== undefined) {
    const runtimeError = definition.permission.runtimeCheck(
      args,
      context.guildId,
      context.userId
    )
    if (runtimeError !== null) {
      return { ok: false, reason: runtimeError }
    }
  }

  return { ok: true }
}

/** 실행 시점의 요청자 권한을 서버에서 새로 받아 확인한다. 승인자의 권한과는 별개다. */
export async function checkLiveToolPermission(
  client: Client,
  definition: ToolDefinition,
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<PermissionCheckResult> {
  if (!context.guildId) {
    if (definition.declaration.name === 'save_memory') {
      return checkToolPermissionLayer3(definition, args, context, false, false)
    }
    return {
      ok: false,
      reason: '개인 메시지에서는 서버 도구를 사용할 수 없어요.',
    }
  }
  const guild = client.guilds.cache.get(context.guildId)
  if (!guild) {
    return { ok: false, reason: '요청한 서버를 찾을 수 없어요.' }
  }
  const [roles, member] = await Promise.all([
    guild.roles.fetch().catch(() => null),
    guild.members
      .fetch({ user: context.userId, force: true })
      .catch(() => null),
  ])
  if (!member || !roles) {
    return { ok: false, reason: '요청자의 현재 서버 권한을 확인할 수 없어요.' }
  }
  return checkToolPermissionLayer3(
    definition,
    args,
    context,
    member.permissions.has(PermissionFlagsBits.ManageGuild),
    member.permissions.has(PermissionFlagsBits.Administrator),
    member.permissions.has(PermissionFlagsBits.ManageChannels)
  )
}
