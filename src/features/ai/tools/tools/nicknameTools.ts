import { resolveGuild } from '../helpers/resolveGuild'
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../toolTypes'
import { Client, type GuildMember } from 'discord.js'

/** 디스코드 닉네임 길이 제한 (2~32) */
const MIN_NICKNAME_LENGTH = 1
const MAX_NICKNAME_LENGTH = 32

function assertBotCanModifyMember(
  member: GuildMember,
  botMember: GuildMember | null
): string | null {
  if (botMember === null) return null
  if (botMember.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    return '리시보다 권한이 높거나 같은 멤버의 닉네임은 변경할 수 없어요.'
  }
  return null
}

// ─── set_nickname ───

export function setNicknameTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'set_nickname',
      description:
        '멤버의 서버 내 닉네임을 변경합니다. 서버 주인은 변경할 수 없고, 리시보다 높거나 같은 멤버도 변경할 수 없어요.',
      parameters: {
        type: 'object',
        properties: {
          member_id: {
            type: 'string',
            description: '닉네임을 변경할 멤버 ID',
          },
          nickname: {
            type: 'string',
            description: `새 닉네임 (1~${MAX_NICKNAME_LENGTH}자)`,
          },
          reason: {
            type: 'string',
            description: '사유 (선택)',
          },
        },
        required: ['member_id', 'nickname'],
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
        const nickname = (args.nickname as string | undefined)?.trim()
        const reason =
          (args.reason as string | undefined)?.trim() ?? 'AI 리시가 적용'

        if (!memberId) {
          return { success: false, message: '멤버 ID를 입력해 주세요.' }
        }
        if (!nickname) {
          return { success: false, message: '새 닉네임을 입력해 주세요.' }
        }
        if (
          nickname.length < MIN_NICKNAME_LENGTH ||
          nickname.length > MAX_NICKNAME_LENGTH
        ) {
          return {
            success: false,
            message: `닉네임은 ${MIN_NICKNAME_LENGTH}~${MAX_NICKNAME_LENGTH}자여야 해요.`,
          }
        }

        const guild = await resolveGuild(client, context)
        const member = await guild.members
          .fetch(memberId)
          .catch(() => undefined)
        if (member === undefined) {
          return { success: false, message: '멤버를 찾을 수 없어요.' }
        }

        if (guild.ownerId === member.id) {
          return {
            success: false,
            message: '서버 주인의 닉네임은 변경할 수 없어요.',
          }
        }

        const block = assertBotCanModifyMember(member, guild.members.me)
        if (block !== null) {
          return { success: false, message: block }
        }

        const previousNickname = member.nickname
        await member.setNickname(nickname, reason)

        const summary = `${member.user.username} 님의 닉네임을 **${nickname}**로 변경했어요.`
        return {
          success: true,
          message: summary,
          summary,
          data: {
            memberId: member.id,
            previous: previousNickname ?? member.user.username,
            current: nickname,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `닉네임 변경 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── reset_nickname ───

export function resetNicknameTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'reset_nickname',
      description:
        '멤버의 서버 내 닉네임을 초기화(원래 유저명으로 복구)합니다. 서버 주인은 변경할 수 없어요.',
      parameters: {
        type: 'object',
        properties: {
          member_id: {
            type: 'string',
            description: '닉네임을 초기화할 멤버 ID',
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
      risk: 'info',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const memberId = (args.member_id as string | undefined)?.trim()
        const reason =
          (args.reason as string | undefined)?.trim() ?? 'AI 리시가 적용'

        if (!memberId) {
          return { success: false, message: '멤버 ID를 입력해 주세요.' }
        }

        const guild = await resolveGuild(client, context)
        const member = await guild.members
          .fetch(memberId)
          .catch(() => undefined)
        if (member === undefined) {
          return { success: false, message: '멤버를 찾을 수 없어요.' }
        }

        if (guild.ownerId === member.id) {
          return {
            success: false,
            message: '서버 주인의 닉네임은 변경할 수 없어요.',
          }
        }

        const block = assertBotCanModifyMember(member, guild.members.me)
        if (block !== null) {
          return { success: false, message: block }
        }

        if (member.nickname === null) {
          return {
            success: false,
            message: `${member.user.username} 님은 닉네임이 설정되어 있지 않아요.`,
          }
        }

        const previousNickname = member.nickname
        await member.setNickname(null, reason)

        const summary = `${previousNickname} 님의 닉네임을 초기화했어요 (원래 이름: **${member.user.username}**).`
        return {
          success: true,
          message: summary,
          summary,
          data: {
            memberId: member.id,
            previous: previousNickname,
            current: member.user.username,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `닉네임 초기화 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
