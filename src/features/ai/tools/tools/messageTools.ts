import { resolveAccessibleChannel } from '../helpers/channelAccess'
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../toolTypes'
import { Client, type Message } from 'discord.js'

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v.trim() : ''
}

// 봇 자신이 보낸 메시지 수정 (디스코드 제약: 남의 메시지는 수정 불가).
export function editMessageTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'edit_message',
      description:
        '봇(자신)이 보낸 메시지의 내용을 수정합니다. message_id와 새 content가 필요해요. 다른 사람 메시지는 수정할 수 없어요.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: '채널 ID (비우면 현재 채널)',
          },
          message_id: { type: 'string', description: '수정할 메시지 ID' },
          content: { type: 'string', description: '새 메시지 내용' },
        },
        required: ['message_id', 'content'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      const channelId = strArg(args, 'channel_id') || context.channelId
      const messageId = strArg(args, 'message_id')
      const content = strArg(args, 'content')
      if (!messageId || !content) {
        return { success: false, message: 'message_id와 content가 필요해요.' }
      }
      const access = await resolveAccessibleChannel(
        client,
        context.userId,
        channelId
      )
      if (!access.ok) return { success: false, message: access.reason }
      const ch = access.channel
      try {
        const msg = await ch.messages.fetch(messageId)
        if (msg.author.id !== client.user?.id) {
          return {
            success: false,
            message: '봇이 보낸 메시지만 수정할 수 있어요.',
          }
        }
        await msg.edit(content)
        return { success: true, message: '메시지를 수정했어요.' }
      } catch (error) {
        const m = error instanceof Error ? error.message : String(error)
        return { success: false, message: `메시지 수정 중 오류: ${m}` }
      }
    },
  }
}

// 메시지 삭제 (되돌리기 불가 → danger, 승인 게이트 통과).
export function deleteMessageTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'delete_message',
      description:
        '채널의 메시지를 삭제합니다. 되돌릴 수 없어요. message_id가 필요해요.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: '채널 ID (비우면 현재 채널)',
          },
          message_id: { type: 'string', description: '삭제할 메시지 ID' },
        },
        required: ['message_id'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'danger',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      const channelId = strArg(args, 'channel_id') || context.channelId
      const messageId = strArg(args, 'message_id')
      if (!messageId)
        return { success: false, message: 'message_id가 필요해요.' }
      const access = await resolveAccessibleChannel(
        client,
        context.userId,
        channelId
      )
      if (!access.ok) return { success: false, message: access.reason }
      const ch = access.channel
      try {
        const msg = await ch.messages.fetch(messageId)
        await msg.delete()
        return { success: true, message: '메시지를 삭제했어요.' }
      } catch (error) {
        const m = error instanceof Error ? error.message : String(error)
        return { success: false, message: `메시지 삭제 중 오류: ${m}` }
      }
    },
  }
}

// 대량 메시지 삭제 (되돌리기 불가 → danger, 승인 게이트 통과).
// 14일 이내는 벌크로 한 번에, 14일 초과는 개별 순차(상한 없음). 승인 카드는 앞에서 한 번만.
export function bulkDeleteMessagesTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'bulk_delete_messages',
      description:
        '채널의 최근 메시지 여러 개를 한 번에 삭제합니다. count(지울 개수)가 필요해요. 14일 이내 메시지는 벌크로 한 번에, 더 오래된 건 하나씩 순차로 지워요. 되돌릴 수 없어요. "메시지 다 지워줘/청소해줘" 같은 대량 삭제 요청에는 delete_message를 여러 번 호출하지 말고 반드시 이 도구를 쓰세요.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: '채널 ID (비우면 현재 채널)',
          },
          count: {
            type: 'number',
            description: '삭제할 최근 메시지 개수 (1 이상)',
          },
        },
        required: ['count'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'danger',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      const channelId = strArg(args, 'channel_id') || context.channelId
      const rawCount = args.count
      const count =
        typeof rawCount === 'number'
          ? Math.floor(rawCount)
          : Number.parseInt(String(rawCount), 10)
      if (!Number.isFinite(count) || count <= 0) {
        return {
          success: false,
          message: '삭제할 개수(count)를 1 이상으로 알려줘요.',
        }
      }
      const access = await resolveAccessibleChannel(
        client,
        context.userId,
        channelId
      )
      if (!access.ok) return { success: false, message: access.reason }
      const ch = access.channel
      try {
        // 1) count개까지 최근 메시지를 모은다(100개씩 페이지네이션).
        const collected: Message[] = []
        let before: string | undefined
        while (collected.length < count) {
          const limit = Math.min(100, count - collected.length)
          const batch = await ch.messages.fetch(
            before === undefined ? { limit } : { limit, before }
          )
          if (batch.size === 0) break
          const arr = [...batch.values()]
          collected.push(...arr)
          before = arr[arr.length - 1]?.id
          if (batch.size < limit) break
        }
        if (collected.length === 0) {
          return { success: true, message: '삭제할 메시지가 없어요.' }
        }

        // 2) 14일 경계로 이분한다(디스코드는 14일 초과 메시지의 벌크 삭제를 막는다).
        const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000
        const now = Date.now()
        const recent = collected.filter(
          (m) => now - m.createdTimestamp < TWO_WEEKS_MS
        )
        const old = collected.filter(
          (m) => now - m.createdTimestamp >= TWO_WEEKS_MS
        )

        let deleted = 0
        let failed = 0

        // 3) 14일 이내: 100개씩 벌크 삭제(1개면 개별).
        for (let i = 0; i < recent.length; i += 100) {
          const chunk = recent.slice(i, i + 100)
          try {
            if (chunk.length === 1) {
              const single = chunk[0]
              if (single !== undefined) {
                await single.delete()
                deleted += 1
              }
            } else {
              const removed = await ch.bulkDelete(chunk, true)
              deleted += removed.size
              // filterOld로 벌크에서 빠진 경계 메시지는 개별로 처리.
              for (const m of chunk) {
                if (!removed.has(m.id)) {
                  try {
                    await m.delete()
                    deleted += 1
                  } catch {
                    failed += 1
                  }
                }
              }
            }
          } catch {
            failed += chunk.length
          }
        }

        // 4) 14일 초과: 개별 순차 삭제(상한 없음). discord.js가 rate limit을 자동 관리.
        for (const m of old) {
          try {
            await m.delete()
            deleted += 1
          } catch {
            failed += 1
          }
        }

        const parts = [`메시지 ${deleted}개를 삭제했어요.`]
        if (old.length > 0) {
          parts.push(`(14일 초과 ${old.length}개는 하나씩 처리)`)
        }
        if (failed > 0) parts.push(`· ${failed}개는 삭제하지 못했어요.`)
        return { success: true, message: parts.join(' ') }
      } catch (error) {
        const m = error instanceof Error ? error.message : String(error)
        return { success: false, message: `대량 삭제 중 오류: ${m}` }
      }
    },
  }
}

// 메시지 고정/고정 해제.
export function pinMessageTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'pin_message',
      description: '메시지를 채널에 고정(핀)합니다. message_id가 필요해요.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: '채널 ID (비우면 현재 채널)',
          },
          message_id: { type: 'string', description: '고정할 메시지 ID' },
        },
        required: ['message_id'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(args, context): Promise<ToolResult> {
      const channelId = strArg(args, 'channel_id') || context.channelId
      const messageId = strArg(args, 'message_id')
      if (!messageId)
        return { success: false, message: 'message_id가 필요해요.' }
      const access = await resolveAccessibleChannel(
        client,
        context.userId,
        channelId
      )
      if (!access.ok) return { success: false, message: access.reason }
      const ch = access.channel
      try {
        const msg = await ch.messages.fetch(messageId)
        await msg.pin()
        return { success: true, message: '메시지를 고정했어요.' }
      } catch (error) {
        const m = error instanceof Error ? error.message : String(error)
        return { success: false, message: `고정 중 오류: ${m}` }
      }
    },
  }
}

export function unpinMessageTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'unpin_message',
      description: '고정된 메시지를 고정 해제합니다. message_id가 필요해요.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: '채널 ID (비우면 현재 채널)',
          },
          message_id: { type: 'string', description: '고정 해제할 메시지 ID' },
        },
        required: ['message_id'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(args, context): Promise<ToolResult> {
      const channelId = strArg(args, 'channel_id') || context.channelId
      const messageId = strArg(args, 'message_id')
      if (!messageId)
        return { success: false, message: 'message_id가 필요해요.' }
      const access = await resolveAccessibleChannel(
        client,
        context.userId,
        channelId
      )
      if (!access.ok) return { success: false, message: access.reason }
      const ch = access.channel
      try {
        const msg = await ch.messages.fetch(messageId)
        await msg.unpin()
        return { success: true, message: '메시지 고정을 해제했어요.' }
      } catch (error) {
        const m = error instanceof Error ? error.message : String(error)
        return { success: false, message: `고정 해제 중 오류: ${m}` }
      }
    },
  }
}

// 메시지에 이모지 반응 추가.
export function reactMessageTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'react_message',
      description:
        '메시지에 이모지 반응을 답니다. message_id와 emoji(유니코드 이모지 또는 <:name:id> 커스텀)가 필요해요.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: '채널 ID (비우면 현재 채널)',
          },
          message_id: { type: 'string', description: '반응을 달 메시지 ID' },
          emoji: {
            type: 'string',
            description: '이모지 (예: 👍 또는 <:name:id>)',
          },
        },
        required: ['message_id', 'emoji'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'info',
    },
    async execute(args, context): Promise<ToolResult> {
      const channelId = strArg(args, 'channel_id') || context.channelId
      const messageId = strArg(args, 'message_id')
      const emoji = strArg(args, 'emoji')
      if (!messageId || !emoji) {
        return { success: false, message: 'message_id와 emoji가 필요해요.' }
      }
      const access = await resolveAccessibleChannel(
        client,
        context.userId,
        channelId
      )
      if (!access.ok) return { success: false, message: access.reason }
      const ch = access.channel
      try {
        const msg = await ch.messages.fetch(messageId)
        await msg.react(emoji)
        return { success: true, message: `${emoji} 반응을 달았어요.` }
      } catch (error) {
        const m = error instanceof Error ? error.message : String(error)
        return { success: false, message: `반응 추가 중 오류: ${m}` }
      }
    },
  }
}

// 채널 최근 메시지에서 키워드 검색(디스코드 검색 API 대신 최근 N개 필터).
export function searchMessagesTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'search_messages',
      description:
        '현재(또는 지정) 채널의 최근 메시지에서 키워드가 포함된 메시지를 찾습니다. 최근 최대 100개를 훑어 최대 10개를 돌려줘요.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: '채널 ID (비우면 현재 채널)',
          },
          query: { type: 'string', description: '찾을 키워드' },
        },
        required: ['query'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'info',
    },
    async execute(args, context): Promise<ToolResult> {
      const channelId = strArg(args, 'channel_id') || context.channelId
      const query = strArg(args, 'query')
      if (!query)
        return { success: false, message: '찾을 키워드(query)가 필요해요.' }
      const access = await resolveAccessibleChannel(
        client,
        context.userId,
        channelId
      )
      if (!access.ok) return { success: false, message: access.reason }
      const ch = access.channel
      try {
        const fetched = await ch.messages.fetch({ limit: 100 })
        const lower = query.toLowerCase()
        const matched = [...fetched.values()]
          .filter((m) => m.content.toLowerCase().includes(lower))
          .slice(0, 10)
        if (matched.length === 0) {
          return {
            success: true,
            message: `"${query}"가 포함된 최근 메시지를 못 찾았어요.`,
          }
        }
        const lines = matched.map(
          (m) =>
            `- ${m.author.username}: ${m.content.slice(0, 80)} (id ${m.id})`
        )
        return {
          success: true,
          message: `"${query}" 검색 결과 ${matched.length}개:\n${lines.join(
            '\n'
          )}`,
        }
      } catch (error) {
        const m = error instanceof Error ? error.message : String(error)
        return { success: false, message: `검색 중 오류: ${m}` }
      }
    },
  }
}
