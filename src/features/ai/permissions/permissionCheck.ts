import type {
  PermissionCheckResult,
  ToolDefinition,
  ToolExecutionContext,
} from '../tools/toolTypes'

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
  hasAdmin: boolean
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
