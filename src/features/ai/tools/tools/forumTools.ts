import {
  permissionListForDescription,
  resolvePermissionOverwrites,
  toCreateOverwrites,
} from '../helpers/permissionOverwrites'
import { resolveGuild } from '../helpers/resolveGuild'
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../toolTypes'
import {
  ChannelType,
  Client,
  type ForumChannel,
  PermissionFlagsBits,
  type ThreadChannel,
} from 'discord.js'

function isForumChannel(channel: unknown): channel is ForumChannel {
  return (
    channel !== null &&
    typeof channel === 'object' &&
    'type' in channel &&
    (channel as { type: ChannelType }).type === ChannelType.GuildForum
  )
}

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

// ─── listForumPostsTool ───

export function listForumPostsTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'list_forum_posts',
      description:
        '포럼 채널의 게시글(포스트) 목록을 불러옵니다. 활성 포스트와 보관된 포스트를 모두 확인할 수 있어요. 각 포스트의 제목, 작성자, 태그, 상태 등을 알 수 있어요.',
      parameters: {
        type: 'object',
        properties: {
          forumId: {
            type: 'string',
            description: '포럼 채널의 ID',
          },
          forumName: {
            type: 'string',
            description: '포럼 채널의 이름 (forumId가 없을 때 사용)',
          },
          includeArchived: {
            type: 'boolean',
            description: '보관된 포스트 포함 여부 (기본값 true)',
          },
          limit: {
            type: 'integer',
            description: '가져올 최대 포스트 수 (1~50, 기본값 25)',
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
        const forumId = args.forumId as string | undefined
        const forumName = args.forumName as string | undefined
        const includeArchived = Boolean(args.includeArchived ?? true)
        const limitRaw = Number(args.limit ?? 25)
        const limit =
          Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 50
            ? limitRaw
            : 25

        const guild = await resolveGuild(client, context)

        let forum: ForumChannel | undefined
        if (forumId) {
          const ch = guild.channels.cache.get(forumId)
          if (ch && isForumChannel(ch)) forum = ch
        }
        if (!forum && forumName) {
          const lower = forumName.toLowerCase()
          for (const ch of guild.channels.cache.values()) {
            if (isForumChannel(ch) && ch.name.toLowerCase() === lower) {
              forum = ch
              break
            }
          }
        }

        if (!forum) {
          return { success: false, message: '포럼 채널을 찾을 수 없어요.' }
        }

        const me = guild.members.me
        if (me) {
          const perms = forum.permissionsFor(me)
          if (perms && !perms.has(PermissionFlagsBits.ViewChannel)) {
            return { success: false, message: '봇이 해당 포럼을 볼 수 없어요.' }
          }
        }

        const threads: ThreadChannel[] = []

        const active = await forum.threads
          .fetchActive()
          .catch(() => ({ threads: new Map<string, ThreadChannel>() }))
        for (const t of active.threads.values()) {
          threads.push(t)
        }

        if (includeArchived) {
          const archived = await forum.threads
            .fetchArchived({ fetchAll: true })
            .catch(() => ({ threads: new Map<string, ThreadChannel>() }))
          for (const t of archived.threads.values()) {
            threads.push(t)
          }
        }

        const posts = threads.slice(0, limit).map((t) => ({
          id: t.id,
          name: t.name,
          authorId: t.ownerId,
          archived: t.archived,
          locked: t.locked,
          createdAt: t.createdAt?.toISOString() ?? null,
          messageCount: t.messageCount,
          appliedTags: t.appliedTags,
          type: t.type === ChannelType.PrivateThread ? 'private' : 'public',
        }))

        if (posts.length === 0) {
          return {
            success: true,
            message: '포럼에 게시글이 없어요.',
            data: {
              count: 0,
              posts: [],
              forum: { id: forum.id, name: forum.name },
            },
            summary: '게시글 없음',
          }
        }

        const summaryLines = posts.map((p) => {
          const tags =
            p.appliedTags.length > 0 ? ` [${p.appliedTags.join(', ')}]` : ''
          const status = p.archived ? ' (보관됨)' : p.locked ? ' (잠김)' : ''
          return `- ${p.name}${tags}${status} (${p.messageCount}개 메시지)`
        })

        return {
          success: true,
          message: `#${forum.name} 포럼의 게시글 ${posts.length}개를 불러왔어요.`,
          data: {
            count: posts.length,
            forum: { id: forum.id, name: forum.name },
            posts,
          },
          summary: summaryLines.join('\n'),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `포럼 게시글 목록 조회 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── readForumPostTool ───

export function readForumPostTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'read_forum_post',
      description:
        '포럼 게시글(포스트)의 내용과 댓글들을 읽어옵니다. 첫 메시지(원문)와 모든 댓글을 시간순으로 확인할 수 있어요.',
      parameters: {
        type: 'object',
        properties: {
          postId: {
            type: 'string',
            description: '읽을 포럼 포스트(스레드)의 ID',
          },
          limit: {
            type: 'integer',
            description: '읽을 메시지 개수 (1~100, 기본값 50)',
          },
          includeBots: {
            type: 'boolean',
            description: '봇 메시지 포함 여부 (기본값 false)',
          },
        },
        required: ['postId'],
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
        const postId = args.postId as string | undefined
        const limitRaw = Number(args.limit ?? 50)
        const includeBots = Boolean(args.includeBots ?? false)

        if (!postId) {
          return { success: false, message: 'postId가 필요해요.' }
        }

        const limit =
          Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100
            ? limitRaw
            : 50

        const guild = await resolveGuild(client, context)

        const channel = guild.channels.cache.get(postId)
        if (!channel || !isThreadChannel(channel)) {
          return { success: false, message: '포럼 포스트를 찾을 수 없어요.' }
        }

        const thread = channel as ThreadChannel

        const me = guild.members.me
        if (me) {
          const perms = thread.permissionsFor(me)
          if (perms && !perms.has(PermissionFlagsBits.ViewChannel)) {
            return {
              success: false,
              message: '봇이 해당 포스트를 볼 수 없어요.',
            }
          }
          if (perms && !perms.has(PermissionFlagsBits.ReadMessageHistory)) {
            return {
              success: false,
              message: '봇이 메시지 기록을 읽을 권한이 없어요.',
            }
          }
        }

        const fetched = await thread.messages.fetch({ limit })

        let starterMessage:
          | { authorName: string; content: string; createdAt: string }
          | undefined
        if (thread.id === thread.lastMessageId && fetched.size === 0) {
          // empty thread
        }

        const messages = [...fetched.values()]
          .filter((m) => includeBots || !m.author.bot)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .map((m) => {
            const msg = {
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
              isStarter: false,
            }
            if (m.id === thread.id) {
              starterMessage = {
                authorName: msg.authorName,
                content: msg.content,
                createdAt: msg.createdAt,
              }
              msg.isStarter = true
            }
            return msg
          })

        if (messages.length === 0) {
          return {
            success: true,
            message: '읽을 메시지가 없어요.',
            data: {
              count: 0,
              messages: [],
              post: { id: thread.id, name: thread.name },
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
          const starterTag = m.isStarter ? ' [원문]' : ''
          return `[${time}] ${m.authorName}${botTag}${starterTag}: ${m.content}`
        })
        const summary = summaryLines.join('\n')

        return {
          success: true,
          message: `#${thread.name} 포스트의 메시지 ${messages.length}개를 읽었어요.`,
          data: {
            count: messages.length,
            post: {
              id: thread.id,
              name: thread.name,
              authorId: thread.ownerId,
              archived: thread.archived,
              locked: thread.locked,
              createdAt: thread.createdAt?.toISOString() ?? null,
              appliedTags: thread.appliedTags,
            },
            starterMessage,
            messages,
            hasMore: fetched.size === limit,
          },
          summary,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `포럼 포스트 읽기 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── createForumTool ───

const FORUM_TAG_NAME_MAX = 20
const FORUM_TAG_MAX_COUNT = 20

interface ParsedTag {
  name: string
  moderated: boolean
}

function parseForumTags(input: unknown): {
  tags?: ParsedTag[]
  error?: string
} {
  if (input === undefined || input === null) return { tags: [] }
  if (!Array.isArray(input)) {
    return { error: 'tags는 문자열 또는 객체 배열이어야 해요.' }
  }
  if (input.length > FORUM_TAG_MAX_COUNT) {
    return { error: `태그는 최대 ${FORUM_TAG_MAX_COUNT}개까지 가능해요.` }
  }
  const tags: ParsedTag[] = []
  for (let i = 0; i < input.length; i++) {
    const raw = input[i]
    if (typeof raw === 'string') {
      const name = raw.trim()
      if (name.length === 0) {
        return { error: `${i + 1}번째 태그 이름이 비어 있어요.` }
      }
      if (name.length > FORUM_TAG_NAME_MAX) {
        return {
          error: `${
            i + 1
          }번째 태그 이름은 ${FORUM_TAG_NAME_MAX}자 이내여야 해요.`,
        }
      }
      tags.push({ name, moderated: false })
    } else if (raw !== null && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>
      const name = (obj.name as string | undefined)?.trim()
      if (!name) {
        return { error: `${i + 1}번째 태그에 name이 없어요.` }
      }
      if (name.length > FORUM_TAG_NAME_MAX) {
        return {
          error: `${
            i + 1
          }번째 태그 이름은 ${FORUM_TAG_NAME_MAX}자 이내여야 해요.`,
        }
      }
      tags.push({
        name,
        moderated: Boolean(obj.moderated ?? false),
      })
    } else {
      return { error: `${i + 1}번째 태그 형식이 잘못됐어요.` }
    }
  }
  return { tags }
}

const CUSTOM_EMOJI_PATTERN = /^([a-zA-Z0-9_]+):(\d+)$/

function parseReactionEmoji(
  input: string | undefined
): { name: string; id: string | null } | undefined {
  if (!input) return undefined
  const trimmed = input.trim()
  if (trimmed.length === 0) return undefined
  const match = trimmed.match(CUSTOM_EMOJI_PATTERN)
  if (match) {
    return { name: match[1], id: match[2] }
  }
  return { name: trimmed, id: null }
}

export function createForumTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'create_forum',
      description:
        '서버에 새로운 포럼 채널을 생성합니다. 태그, 카테고리, 역할/멤버별 권한을 지정할 수 있어요.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '생성할 포럼 채널 이름',
          },
          topic: {
            type: 'string',
            description: '포럼 채널의 주제/설명 (선택)',
          },
          category_id: {
            type: 'string',
            description: '상위 카테고리 ID (선택)',
          },
          tags: {
            type: 'array',
            description:
              '사용 가능한 태그 목록 (최대 20개). 문자열 배열 또는 { name, moderated } 객체 배열. 예: ["질문", "공지"]',
            items: { type: 'object', description: '태그 항목' },
          },
          default_reaction_emoji: {
            type: 'string',
            description: '기본 반응 이모지 (선택). 예: "👍" 또는 "name:id"',
          },
          permission_overwrites: {
            type: 'array',
            description: `권한 오버라이드 목록 (선택). 각 항목: { id: 역할/멤버 ID, type: 'role'|'member' (기본 role), allow?: [권한...], deny?: [권한...] }. 가능한 권한: ${permissionListForDescription()}`,
            items: { type: 'object', description: '권한 오버라이드 항목' },
          },
        },
        required: ['name'],
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
        const name = (args.name as string | undefined)?.trim()
        const topic = (args.topic as string | undefined)?.trim() || undefined
        const categoryId =
          (args.category_id as string | undefined)?.trim() || undefined
        const defaultReactionEmoji = parseReactionEmoji(
          (args.default_reaction_emoji as string | undefined)?.trim() ||
            undefined
        )

        if (!name) {
          return { success: false, message: '포럼 이름을 입력해 주세요.' }
        }

        const { tags, error: tagError } = parseForumTags(args.tags)
        if (tagError !== undefined || tags === undefined) {
          return { success: false, message: tagError ?? '태그 오류' }
        }

        const { overwrites, error: overwriteError } =
          resolvePermissionOverwrites(args.permission_overwrites)
        if (overwriteError !== undefined) {
          return { success: false, message: overwriteError }
        }

        const guild = await resolveGuild(client, context)
        const created = await guild.channels.create({
          name,
          type: ChannelType.GuildForum,
          topic,
          parent: categoryId,
          defaultReactionEmoji,
          availableTags: tags.map((t) => ({
            name: t.name,
            moderated: t.moderated,
          })),
          permissionOverwrites: toCreateOverwrites(overwrites),
        })

        const summary = `#${created.name} 포럼을 만들었어요! (태그 ${tags.length}개)`
        return {
          success: true,
          message: summary,
          summary,
          data: {
            id: created.id,
            name: created.name,
            parentId: created.parentId,
            tagCount: tags.length,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `포럼 생성 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
