import { resolveGuild } from '../helpers/resolveGuild'
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../toolTypes'
import {
  ChannelType,
  Client,
  PermissionFlagsBits,
  type ThreadChannel,
} from 'discord.js'

function isThreadChannel(channel: unknown): channel is ThreadChannel {
  return (
    channel !== null &&
    typeof channel === 'object' &&
    'type' in channel &&
    ((channel as { type: ChannelType }).type === ChannelType.PublicThread ||
      (channel as { type: ChannelType }).type === ChannelType.PrivateThread ||
      (channel as { type: ChannelType }).type ===
        ChannelType.AnnouncementThread)
  )
}

// ─── editThreadTool ───

export function editThreadTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'edit_thread',
      description:
        '스레드의 이름, 보관 상태, 자동 보관 시간, 잠금, 슬로우 모드, 초대 가능 여부를 수정합니다. threadId로 대상을 지정하고, 수정할 속성을 제공해야 해요.',
      parameters: {
        type: 'object',
        properties: {
          threadId: {
            type: 'string',
            description: '수정할 스레드의 ID',
          },
          name: {
            type: 'string',
            description: '새 스레드 이름 (선택 사항)',
          },
          archived: {
            type: 'boolean',
            description:
              '스레드 보관 여부 (true: 보관, false: 보관 해제, 선택 사항)',
          },
          autoArchiveDuration: {
            type: 'integer',
            description:
              '자동 보관 시간 (분, 60/1440/4320/10080 중 하나, 활동 없을 때 자동 보관, 선택 사항)',
          },
          locked: {
            type: 'boolean',
            description:
              '스레드 잠금 여부 (true: 잠금, false: 잠금 해제, 선택 사항)',
          },
          slowmode: {
            type: 'integer',
            description:
              '슬로우 모드 지연 시간 (초, 0-21600, 0이면 비활성화, 선택 사항)',
          },
          invitable: {
            type: 'boolean',
            description:
              '비모더레이터가 멤버 추가 가능 여부 (비공개 스레드 전용, 선택 사항)',
          },
        },
        required: ['threadId'],
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
        const threadId = args.threadId as string | undefined
        const name = args.name as string | undefined
        const archived = args.archived as boolean | undefined
        const autoArchiveDuration = args.autoArchiveDuration as
          | number
          | undefined
        const locked = args.locked as boolean | undefined
        const slowmode = args.slowmode as number | undefined
        const invitable = args.invitable as boolean | undefined

        if (!threadId) {
          return { success: false, message: 'threadId가 필요해요.' }
        }

        if (
          !name &&
          archived === undefined &&
          autoArchiveDuration === undefined &&
          locked === undefined &&
          slowmode === undefined &&
          invitable === undefined
        ) {
          return {
            success: false,
            message:
              '수정할 속성을 최소 하나 제공해야 해요 (name, archived, autoArchiveDuration, locked, slowmode, invitable).',
          }
        }

        const guild = await resolveGuild(client, context)

        let thread: ThreadChannel | undefined
        const channel = guild.channels.cache.get(threadId)
        if (channel && isThreadChannel(channel)) {
          thread = channel
        }

        if (!thread) {
          return { success: false, message: '스레드를 찾을 수 없어요.' }
        }

        const editPayload: Record<string, unknown> = {}

        if (name && typeof name === 'string' && name.trim().length > 0) {
          editPayload.name = name.trim()
        }

        if (archived !== undefined) {
          editPayload.archived = Boolean(archived)
        }

        if (autoArchiveDuration !== undefined) {
          const durationNum = Number(autoArchiveDuration)
          const validDurations = [60, 1440, 4320, 10080]
          if (!validDurations.includes(durationNum)) {
            return {
              success: false,
              message: `autoArchiveDuration은 ${validDurations.join(
                ', '
              )} 분 중 하나여야 해요.`,
            }
          }
          editPayload.autoArchiveDuration = durationNum
        }

        if (locked !== undefined) {
          editPayload.locked = Boolean(locked)
        }

        if (slowmode !== undefined) {
          const slowmodeNum = Number(slowmode)
          if (
            !Number.isInteger(slowmodeNum) ||
            slowmodeNum < 0 ||
            slowmodeNum > 21600
          ) {
            return {
              success: false,
              message: 'slowmode는 0-21600 사이의 정수여야 해요.',
            }
          }
          editPayload.rateLimitPerUser = slowmodeNum
        }

        if (invitable !== undefined) {
          if (thread.type === ChannelType.PublicThread) {
            return {
              success: false,
              message: 'invitable은 비공개 스레드에서만 설정할 수 있어요.',
            }
          }
          editPayload.invitable = Boolean(invitable)
        }

        if (Object.keys(editPayload).length === 0) {
          return {
            success: false,
            message: '유효한 속성을 제공해야 해요.',
          }
        }

        await thread.edit(editPayload)

        const changes = Object.keys(editPayload).join(', ')
        return {
          success: true,
          message: `스레드를 수정했어요. 변경된 속성: ${changes}`,
          data: {
            id: thread.id,
            name: editPayload.name ?? thread.name,
            changes,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `스레드 수정 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── readThreadMessagesTool ───

export function readThreadMessagesTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'read_thread_messages',
      description:
        '스레드 또는 포럼 포스트의 메시지들을 읽어옵니다. 누가 언제 무슨 말을 했는지 확인할 수 있어요. 포럼 포스트도 스레드이므로 동일하게 읽을 수 있어요.',
      parameters: {
        type: 'object',
        properties: {
          threadId: {
            type: 'string',
            description: '메시지를 읽을 스레드 또는 포럼 포스트의 ID',
          },
          limit: {
            type: 'integer',
            description: '읽을 메시지 개수 (1~100, 기본값 50)',
          },
          includeBots: {
            type: 'boolean',
            description: '봇 메시지 포함 여부 (기본값 false)',
          },
          before: {
            type: 'string',
            description:
              '이 메시지 ID 이전의 메시지만 가져옴 (페이지네이션, 선택 사항)',
          },
          after: {
            type: 'string',
            description:
              '이 메시지 ID 이후의 메시지만 가져옴 (페이지네이션, 선택 사항)',
          },
        },
        required: ['threadId'],
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
        const threadId = args.threadId as string | undefined
        const limitRaw = Number(args.limit ?? 50)
        const includeBots = Boolean(args.includeBots ?? false)
        const before = args.before as string | undefined
        const after = args.after as string | undefined

        if (!threadId) {
          return { success: false, message: 'threadId가 필요해요.' }
        }

        const limit =
          Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100
            ? limitRaw
            : 50

        const guild = await resolveGuild(client, context)

        const channel = guild.channels.cache.get(threadId)
        if (!channel || !isThreadChannel(channel)) {
          return { success: false, message: '스레드를 찾을 수 없어요.' }
        }

        const thread = channel as ThreadChannel

        const me = guild.members.me
        if (me) {
          const perms = thread.permissionsFor(me)
          if (perms && !perms.has(PermissionFlagsBits.ViewChannel)) {
            return {
              success: false,
              message: '봇이 해당 스레드를 볼 수 없어요.',
            }
          }
          if (perms && !perms.has(PermissionFlagsBits.ReadMessageHistory)) {
            return {
              success: false,
              message: '봇이 메시지 기록을 읽을 권한이 없어요.',
            }
          }
        }

        const fetchOptions: { limit: number; before?: string; after?: string } =
          { limit }
        if (before) fetchOptions.before = before
        if (after) fetchOptions.after = after

        const fetched = await thread.messages.fetch(fetchOptions)

        const messages = [...fetched.values()]
          .filter((m) => includeBots || !m.author.bot)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .map((m) => ({
            id: m.id,
            authorId: m.author.id,
            authorName:
              m.member?.displayName ??
              m.author.displayName ??
              m.author.username,
            isBot: m.author.bot,
            content:
              m.content.length > 500
                ? `${m.content.slice(0, 500)}...`
                : m.content,
            createdAt: m.createdAt.toISOString(),
            attachments:
              m.attachments.size > 0
                ? m.attachments.map((a) => ({
                    filename: a.name,
                    url: a.url,
                    contentType: a.contentType,
                  }))
                : undefined,
            embedCount: m.embeds.length,
            replyTo: m.reference?.messageId ?? undefined,
          }))

        if (messages.length === 0) {
          return {
            success: true,
            message: '읽을 메시지가 없어요.',
            data: {
              count: 0,
              messages: [],
              thread: { id: thread.id, name: thread.name },
            },
            summary: '메시지 없음',
          }
        }

        const summaryLines = messages.map((m) => {
          const time = new Date(m.createdAt).toLocaleString('ko-KR', {
            timeZone: 'Asia/Seoul',
            hour12: false,
          })
          const botTag = m.isBot ? ' [봇]' : ''
          return `[${time}] ${m.authorName}${botTag}: ${m.content}`
        })
        const summary = summaryLines.join('\n')

        return {
          success: true,
          message: `#${thread.name} 스레드의 메시지 ${messages.length}개를 읽었어요.`,
          data: {
            count: messages.length,
            thread: {
              id: thread.id,
              name: thread.name,
              parentId: thread.parentId,
              archived: thread.archived,
              locked: thread.locked,
            },
            messages,
            hasMore: fetched.size === limit,
          },
          summary,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `스레드 메시지 읽기 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
