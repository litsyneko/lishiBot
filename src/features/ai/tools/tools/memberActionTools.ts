import { Client } from 'discord.js'
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../toolTypes'
import { resolveGuild } from '../helpers/resolveGuild'

export function timeoutMemberTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'timeout_member',
      description:
        '멤버를 일정 시간 동안 타임아웃합니다. 타임아웃 중에는 메시지 전송/반응이 제한돼요. 최대 28일까지 가능합니다.',
      parameters: {
        type: 'object',
        properties: {
          member_id: {
            type: 'string',
            description: '타임아웃할 멤버 ID',
          },
          duration_seconds: {
            type: 'integer',
            description: '타임아웃 지속 시간 (초). 예: 60=1분, 3600=1시간, 86400=1일',
          },
          reason: {
            type: 'string',
            description: '사유 (선택)',
          },
        },
        required: ['member_id', 'duration_seconds'],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      try {
        const memberId = (args.member_id as string | undefined)?.trim()
        const durationSeconds = Number(args.duration_seconds)
        const reason = (args.reason as string | undefined)?.trim() ?? 'AI 리시가 적용'

        if (!memberId) {
          return { success: false, message: '멤버 ID를 입력해 주세요.' }
        }
        if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
          return { success: false, message: '지속 시간은 1초 이상의 정수로 입력해 주세요.' }
        }
        if (durationSeconds > 28 * 24 * 60 * 60) {
          return { success: false, message: '최대 28일(2419200초)까지 가능해요.' }
        }

        const guild = await resolveGuild(client, context)

        const member = await guild.members.fetch(memberId).catch(() => undefined)
        if (member === undefined) {
          return { success: false, message: '멤버를 찾을 수 없어요.' }
        }

        if (guild.ownerId === member.id) {
          return { success: false, message: '서버 주인에게는 타임아웃을 할 수 없어요.' }
        }

        const me = guild.members.me
        if (me !== null && me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
          return { success: false, message: '리시보다 권한이 높거나 같은 멤버에게는 작업할 수 없어요.' }
        }

        const durationMs = durationSeconds * 1000
        await member.timeout(durationMs, reason)

        const summary = `${member.displayName} 님을 ${durationSeconds}초 동안 타임아웃했어요.`
        return {
          success: true,
          message: summary,
          summary,
          data: { memberId: member.id, durationSeconds },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, message: `타임아웃 중 오류가 발생했어요: ${message}` }
      }
    },
  }
}

export function removeTimeoutMemberTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'remove_timeout',
      description: '멤버의 타임아웃을 해제합니다.',
      parameters: {
        type: 'object',
        properties: {
          member_id: {
            type: 'string',
            description: '타임아웃을 해제할 멤버 ID',
          },
        },
        required: ['member_id'],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'info',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      try {
        const memberId = (args.member_id as string | undefined)?.trim()
        if (!memberId) {
          return { success: false, message: '멤버 ID를 입력해 주세요.' }
        }

        const guild = await resolveGuild(client, context)

        const member = await guild.members.fetch(memberId).catch(() => undefined)
        if (member === undefined) {
          return { success: false, message: '멤버를 찾을 수 없어요.' }
        }

        if (!member.isCommunicationDisabled()) {
          return { success: false, message: `${member.displayName} 님은 타임아웃 상태가 아니에요.` }
        }

        await member.timeout(null, 'AI 리시가 해제')

        const summary = `${member.displayName} 님의 타임아웃을 해제했어요.`
        return {
          success: true,
          message: summary,
          summary,
          data: { memberId: member.id },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, message: `타임아웃 해제 중 오류가 발생했어요: ${message}` }
      }
    },
  }
}

export function banMemberTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'ban_member',
      description: '멤버를 서버에서 차단(ban)합니다. 차단 시 최근 메시지를 삭제할 수 있어요.',
      parameters: {
        type: 'object',
        properties: {
          member_id: {
            type: 'string',
            description: '차단할 멤버 ID',
          },
          reason: {
            type: 'string',
            description: '차단 사유 (선택)',
          },
          delete_message_seconds: {
            type: 'integer',
            description: '최근 메시지 삭제 범위 (초, 최대 604800=7일, 기본값 0)',
          },
        },
        required: ['member_id'],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'danger',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      try {
        const memberId = (args.member_id as string | undefined)?.trim()
        const reason = (args.reason as string | undefined)?.trim() ?? 'AI 리시가 적용'
        const deleteMessageSeconds = Math.min(
          Math.max(Number(args.delete_message_seconds ?? 0), 0),
          604800,
        )

        if (!memberId) {
          return { success: false, message: '멤버 ID를 입력해 주세요.' }
        }

        const guild = await resolveGuild(client, context)

        if (guild.ownerId === memberId) {
          return { success: false, message: '서버 주인을 차단할 수 없어요.' }
        }

        const member = await guild.members.fetch(memberId).catch(() => undefined)
        if (member !== undefined) {
          const me = guild.members.me
          if (me !== null && me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
            return { success: false, message: '리시보다 권한이 높거나 같은 멤버를 차단할 수 없어요.' }
          }
        }

        await guild.members.ban(memberId, {
          reason,
          deleteMessageSeconds: deleteMessageSeconds > 0 ? deleteMessageSeconds : undefined,
        })

        const summary = `<@${memberId}> 님을 차단했어요.`
        return {
          success: true,
          message: summary,
          summary,
          data: { memberId },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, message: `차단 중 오류가 발생했어요: ${message}` }
      }
    },
  }
}

export function unbanMemberTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'unban_member',
      description: '차단된 멤버의 차단을 해제합니다.',
      parameters: {
        type: 'object',
        properties: {
          member_id: {
            type: 'string',
            description: '차단 해제할 멤버 ID',
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
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      try {
        const memberId = (args.member_id as string | undefined)?.trim()
        if (!memberId) {
          return { success: false, message: '멤버 ID를 입력해 주세요.' }
        }

        const guild = await resolveGuild(client, context)
        await guild.members.unban(memberId).catch(() => {
          throw new Error('해당 멤버가 차단 목록에 없어요.')
        })

        const summary = `<@${memberId}> 님의 차단을 해제했어요.`
        return {
          success: true,
          message: summary,
          summary,
          data: { memberId },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, message: `차단 해제 중 오류가 발생했어요: ${message}` }
      }
    },
  }
}

export function kickMemberTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'kick_member',
      description: '멤버를 서버에서 추방(kick)합니다. 다시 초대하면 돌아올 수 있어요.',
      parameters: {
        type: 'object',
        properties: {
          member_id: {
            type: 'string',
            description: '추방할 멤버 ID',
          },
          reason: {
            type: 'string',
            description: '추방 사유 (선택)',
          },
        },
        required: ['member_id'],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'danger',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      try {
        const memberId = (args.member_id as string | undefined)?.trim()
        const reason = (args.reason as string | undefined)?.trim() ?? 'AI 리시가 적용'

        if (!memberId) {
          return { success: false, message: '멤버 ID를 입력해 주세요.' }
        }

        const guild = await resolveGuild(client, context)

        const member = await guild.members.fetch(memberId).catch(() => undefined)
        if (member === undefined) {
          return { success: false, message: '멤버를 찾을 수 없어요.' }
        }

        if (guild.ownerId === member.id) {
          return { success: false, message: '서버 주인을 추방할 수 없어요.' }
        }

        const me = guild.members.me
        if (me !== null && me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
          return { success: false, message: '리시보다 권한이 높거나 같은 멤버를 추방할 수 없어요.' }
        }

        await member.kick(reason)

        const summary = `${member.displayName} 님을 추방했어요.`
        return {
          success: true,
          message: summary,
          summary,
          data: { memberId: member.id },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, message: `추방 중 오류가 발생했어요: ${message}` }
      }
    },
  }
}
