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
import { Routes } from 'discord-api-types/v10'
import {
  ChannelType,
  Client,
  Collection,
  GuildBasedChannel,
  type Message,
  PermissionFlagsBits,
} from 'discord.js'

// ─── Helpers ───

function findChannelByName(
  channels: Iterable<GuildBasedChannel>,
  name: string
): GuildBasedChannel | undefined {
  const lower = name.toLowerCase()
  for (const c of channels) {
    if (c.name.toLowerCase() === lower) return c
  }
  return undefined
}

// ─── createChannelTool ───

export function createChannelTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'create_channel',
      description:
        '서버에 새로운 채널을 생성합니다. 텍스트, 음성, 포럼 채널을 만들 수 있고 역할/멤버별 권한을 지정할 수 있어요.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '생성할 채널의 이름',
          },
          type: {
            type: 'string',
            description: '생성할 채널의 유형 (기본값: text)',
            enum: ['text', 'voice', 'forum'],
          },
          topic: {
            type: 'string',
            description: '채널의 주제/설명 (선택 사항)',
          },
          category_id: {
            type: 'string',
            description: '상위 카테고리 ID (선택)',
          },
          nsfw: {
            type: 'boolean',
            description: 'NSFW 여부 (선택, 기본값 false)',
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
        const name = args.name as string
        const type =
          (args.type as 'text' | 'voice' | 'forum' | undefined) ?? 'text'
        const topic = args.topic as string | undefined
        const categoryId =
          (args.category_id as string | undefined)?.trim() || undefined
        const nsfw = args.nsfw as boolean | undefined

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
          return { success: false, message: '채널 이름이 필요해요.' }
        }

        const { overwrites, error: overwriteError } =
          resolvePermissionOverwrites(args.permission_overwrites)
        if (overwriteError !== undefined) {
          return { success: false, message: overwriteError }
        }

        const guild = await resolveGuild(client, context)

        const channelType =
          type === 'voice'
            ? ChannelType.GuildVoice
            : type === 'forum'
            ? ChannelType.GuildForum
            : ChannelType.GuildText

        const created = await guild.channels.create({
          name: name.trim(),
          type: channelType,
          topic: topic?.trim() || undefined,
          parent: categoryId,
          nsfw: type === 'text' ? nsfw : undefined,
          permissionOverwrites: toCreateOverwrites(overwrites),
        })

        return {
          success: true,
          message: `#${created.name} 채널을 만들었어요!`,
          data: {
            id: created.id,
            name: created.name,
            type: created.type,
            parentId: created.parentId,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `채널 생성 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── deleteChannelTool ───

export function deleteChannelTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'delete_channel',
      description:
        '서버의 채널을 삭제합니다. 채널 ID 또는 채널 이름으로 삭제할 채널을 지정할 수 있어요. 유일한 텍스트 채널이나 시스템 채널은 삭제할 수 없어요.',
      parameters: {
        type: 'object',
        properties: {
          channelId: {
            type: 'string',
            description: '삭제할 채널의 ID',
          },
          channelName: {
            type: 'string',
            description: '삭제할 채널의 이름 (channelId가 없을 때 사용)',
          },
        },
        required: [],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'danger',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const channelId = args.channelId as string | undefined
        const channelName = args.channelName as string | undefined

        if (!channelId && !channelName) {
          return {
            success: false,
            message: 'channelId 또는 channelName 중 하나는 필요해요.',
          }
        }

        const guild = await resolveGuild(client, context)

        let target: GuildBasedChannel | undefined

        if (channelId) {
          target = guild.channels.cache.get(channelId)
        }

        if (!target && channelName) {
          target = findChannelByName(guild.channels.cache.values(), channelName)
        }

        if (!target) {
          return { success: false, message: '삭제할 채널을 찾을 수 없어요.' }
        }

        // 시스템 채널은 삭제 금지
        if (guild.systemChannelId && target.id === guild.systemChannelId) {
          return {
            success: false,
            message: '시스템 채널은 삭제할 수 없어요.',
          }
        }

        // 유일한 텍스트 채널은 삭제 금지
        const textChannels = guild.channels.cache.filter(
          (c) => c.type === ChannelType.GuildText
        )
        if (target.type === ChannelType.GuildText && textChannels.size <= 1) {
          return {
            success: false,
            message: '서버의 유일한 텍스트 채널은 삭제할 수 없어요.',
          }
        }

        const channelNameForMsg = target.name
        await guild.channels.delete(target.id)

        return {
          success: true,
          message: '채널을 삭제했어요.',
          data: {
            id: target.id,
            name: channelNameForMsg,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `채널 삭제 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── editChannelTool ───

export function editChannelTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'edit_channel',
      description:
        '채널의 이름, 주제, 속도 제한, NSFW, 비트레이트, 사용자 제한, 카테고리, 음성 채널 상태 메시지 등을 수정합니다. channelId 또는 channelName으로 대상을 지정하고, 수정할 속성을 제공해야 해요.',
      parameters: {
        type: 'object',
        properties: {
          channelId: {
            type: 'string',
            description: '수정할 채널의 ID',
          },
          channelName: {
            type: 'string',
            description: '수정할 채널의 이름 (channelId가 없을 때 사용)',
          },
          name: {
            type: 'string',
            description: '새 채널 이름 (선택 사항)',
          },
          topic: {
            type: 'string',
            description: '새 채널 주제/설명 (텍스트 채널 전용, 선택 사항)',
          },
          slowmode: {
            type: 'integer',
            description:
              '슬로우 모드 지연 시간 (초, 0-21600, 텍스트 채널 전용, 0이면 비활성화, 선택 사항)',
          },
          nsfw: {
            type: 'boolean',
            description: 'NSFW 채널 여부 (텍스트 채널 전용, 선택 사항)',
          },
          bitrate: {
            type: 'integer',
            description:
              '음성 채널 비트레이트 (bps, 8000-96000, 음성 채널 전용, 선택 사항)',
          },
          userLimit: {
            type: 'integer',
            description:
              '음성 채널 사용자 제한 (0-99, 0이면 무제한, 음성 채널 전용, 선택 사항)',
          },
          parent: {
            type: 'string',
            description: '채널을 이동할 카테고리 ID (선택 사항)',
          },
          position: {
            type: 'integer',
            description: '카테고리 내 채널 위치 (0부터 시작, 선택 사항)',
          },
          status: {
            type: 'string',
            description:
              '음성 채널 상태 메시지 (최대 500자, 음성/스테이지 채널 전용, 비우면 제거, 선택 사항)',
          },
        },
        required: [],
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
        const channelId = args.channelId as string | undefined
        const channelName = args.channelName as string | undefined
        const name = args.name as string | undefined
        const topic = args.topic as string | undefined
        const slowmode = args.slowmode as number | undefined
        const nsfw = args.nsfw as boolean | undefined
        const bitrate = args.bitrate as number | undefined
        const userLimit = args.userLimit as number | undefined
        const parent = args.parent as string | undefined
        const position = args.position as number | undefined
        const status = args.status as string | undefined

        if (!channelId && !channelName) {
          return {
            success: false,
            message: 'channelId 또는 channelName 중 하나는 필요해요.',
          }
        }

        if (
          !name &&
          topic === undefined &&
          slowmode === undefined &&
          nsfw === undefined &&
          bitrate === undefined &&
          userLimit === undefined &&
          !parent &&
          position === undefined &&
          status === undefined
        ) {
          return {
            success: false,
            message:
              '수정할 속성을 최소 하나 제공해야 해요 (name, topic, slowmode, nsfw, bitrate, userLimit, parent, position, status).',
          }
        }

        const guild = await resolveGuild(client, context)

        let channel: GuildBasedChannel | undefined
        if (channelId) {
          channel = guild.channels.cache.get(channelId)
        }
        if (!channel && channelName) {
          channel = findChannelByName(
            guild.channels.cache.values(),
            channelName
          )
        }

        if (!channel) {
          return { success: false, message: '채널을 찾을 수 없어요.' }
        }

        const isTextChannel = channel.type === ChannelType.GuildText
        const isVoiceChannel = channel.type === ChannelType.GuildVoice

        const editPayload: Record<string, unknown> = {}

        if (name && typeof name === 'string' && name.trim().length > 0) {
          editPayload.name = name.trim()
        }

        if (isTextChannel) {
          if (topic !== undefined && typeof topic === 'string') {
            editPayload.topic = topic
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
          if (nsfw !== undefined) {
            editPayload.nsfw = Boolean(nsfw)
          }
        }

        if (isVoiceChannel) {
          if (bitrate !== undefined) {
            const bitrateNum = Number(bitrate)
            if (
              !Number.isInteger(bitrateNum) ||
              bitrateNum < 8000 ||
              bitrateNum > 96000
            ) {
              return {
                success: false,
                message: 'bitrate는 8000-96000 사이의 정수여야 해요.',
              }
            }
            editPayload.bitrate = bitrateNum
          }
          if (userLimit !== undefined) {
            const userLimitNum = Number(userLimit)
            if (
              !Number.isInteger(userLimitNum) ||
              userLimitNum < 0 ||
              userLimitNum > 99
            ) {
              return {
                success: false,
                message: 'userLimit은 0-99 사이의 정수여야 해요.',
              }
            }
            editPayload.userLimit = userLimitNum
          }
        }

        if (parent) {
          const parentCategory = guild.channels.cache.get(parent)
          if (
            !parentCategory ||
            parentCategory.type !== ChannelType.GuildCategory
          ) {
            return {
              success: false,
              message: '해당 카테고리를 찾을 수 없어요.',
            }
          }
          editPayload.parent = parentCategory.id
        }

        if (position !== undefined) {
          const positionNum = Number(position)
          if (!Number.isInteger(positionNum) || positionNum < 0) {
            return {
              success: false,
              message: 'position은 0 이상의 정수여야 해요.',
            }
          }
          editPayload.position = positionNum
        }

        if (status !== undefined) {
          if (
            channel.type !== ChannelType.GuildVoice &&
            channel.type !== ChannelType.GuildStageVoice
          ) {
            return {
              success: false,
              message:
                'status는 음성 채널 또는 스테이지 채널에서만 설정할 수 있어요.',
            }
          }
          if (status.length > 500) {
            return {
              success: false,
              message: 'status는 최대 500자까지 입력할 수 있어요.',
            }
          }
          await client.rest.put(Routes.channelVoiceStatus(channel.id), {
            body: { status: status.length === 0 ? null : status },
          })
        }

        if (Object.keys(editPayload).length === 0 && status === undefined) {
          return {
            success: false,
            message: '채널 유형에 맞는 유효한 속성을 제공해야 해요.',
          }
        }

        if (Object.keys(editPayload).length > 0) {
          await channel.edit(editPayload)
        }

        const changes = Object.keys(editPayload)
        if (status !== undefined) changes.push('status')

        return {
          success: true,
          message: `채널을 수정했어요. 변경된 속성: ${changes.join(', ')}`,
          data: {
            id: channel.id,
            name: editPayload.name ?? channel.name,
            changes: changes.join(', '),
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `채널 수정 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── lookupChannelTool ───

export function lookupChannelTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'lookup_channel',
      description:
        '채널의 상세 정보를 조회합니다. 채널 이름이나 ID로 검색할 수 있어요. 채널 유형, 카테고리, 주제, 생성일, 위치 등을 확인할 수 있어요.',
      parameters: {
        type: 'object',
        properties: {
          channelId: {
            type: 'string',
            description: '조회할 채널의 ID',
          },
          channelName: {
            type: 'string',
            description: '조회할 채널의 이름 (channelId가 없을 때 사용)',
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
        const channelId =
          (args.channelId as string | undefined) ?? context.channelId
        const channelName = args.channelName as string | undefined

        const guild = await resolveGuild(client, context)

        let target: GuildBasedChannel | undefined
        if (channelId) {
          target = guild.channels.cache.get(channelId)
        }
        if (!target && channelName) {
          target = findChannelByName(guild.channels.cache.values(), channelName)
        }
        if (!target) {
          return { success: false, message: '해당 채널을 찾을 수 없어요.' }
        }

        const typeNames: Record<number, string> = {
          [ChannelType.GuildText]: '텍스트',
          [ChannelType.GuildVoice]: '음성',
          [ChannelType.GuildCategory]: '카테고리',
          [ChannelType.GuildAnnouncement]: '공지',
          [ChannelType.GuildForum]: '포럼',
        }

        const parentInfo = target.parent
          ? { id: target.parent.id, name: target.parent.name }
          : null

        const summaryParts = [
          `이름: ${target.name}`,
          `유형: ${typeNames[target.type] ?? '기타'}`,
          target.parent ? `카테고리: ${target.parent.name}` : '카테고리: 없음',
        ]
        if ('topic' in target && (target as { topic?: string }).topic) {
          summaryParts.push(`주제: ${(target as { topic?: string }).topic}`)
        }

        return {
          success: true,
          message: `#${target.name} 채널 정보를 찾았어요.`,
          data: {
            id: target.id,
            name: target.name,
            type: typeNames[target.type] ?? `기타(${target.type})`,
            typeCode: target.type,
            category: parentInfo,
            position: 'position' in target ? target.position : null,
            topic:
              'topic' in target
                ? (target as { topic?: string }).topic ?? null
                : null,
            nsfw:
              'nsfw' in target
                ? Boolean((target as { nsfw?: boolean }).nsfw)
                : null,
            createdAt: target.createdAt?.toISOString() ?? null,
          },
          summary: summaryParts.join('\n'),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `채널 조회 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── listChannelsTool ───

export function listChannelsTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'list_channels',
      description:
        '서버의 채널 목록을 불러옵니다. type을 지정하면 해당 유형만 필터링돼요.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: '필터링할 채널 유형 (선택 사항, 미지정 시 전체)',
            enum: ['text', 'voice', 'category'],
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
        const type = args.type as 'text' | 'voice' | 'category' | undefined

        const guild = await resolveGuild(client, context)

        const typeMap: Record<string, ChannelType> = {
          text: ChannelType.GuildText,
          voice: ChannelType.GuildVoice,
          category: ChannelType.GuildCategory,
        }

        let channels = [...guild.channels.cache.values()]

        if (type) {
          const targetType = typeMap[type]
          channels = channels.filter((c) => c.type === targetType)
        }

        const currentChannelId = context.channelId

        const list = channels
          .filter((c) => typeof c.name === 'string')
          .map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            isCurrent: c.id === currentChannelId,
          }))

        const typeIcon = (t: number) =>
          t === ChannelType.GuildText
            ? '💬'
            : t === ChannelType.GuildVoice
            ? '🔊'
            : t === ChannelType.GuildCategory
            ? '📁'
            : t === ChannelType.GuildAnnouncement
            ? '📢'
            : '📁'

        const summary = list
          .map(
            (c) => `${typeIcon(c.type)} ${c.isCurrent ? '👉 ' : ''}${c.name}`
          )
          .join('\n')

        return {
          success: true,
          message: '서버 채널 목록을 불러왔어요.',
          data: {
            count: list.length,
            channels: list,
          },
          summary,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `채널 목록 불러오기 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── readChannelMessagesTool ───

type ReadableChannel = GuildBasedChannel & {
  messages: {
    fetch: (opts: {
      limit: number
      before?: string
      after?: string
    }) => Promise<Collection<string, Message<true>>>
  }
}

function isReadableChannel(
  channel: GuildBasedChannel
): channel is ReadableChannel {
  return channel.isTextBased()
}

export function readChannelMessagesTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'read_channel_messages',
      description:
        '채널의 최근 메시지들을 읽어옵니다. 누가 언제 무슨 말을 했는지 확인할 수 있어요. channelId/channelName으로 대상을 지정하고, limit로 개수를 조절하세요.',
      parameters: {
        type: 'object',
        properties: {
          channelId: {
            type: 'string',
            description: '메시지를 읽을 채널의 ID',
          },
          channelName: {
            type: 'string',
            description: '메시지를 읽을 채널의 이름 (channelId가 없을 때 사용)',
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
        const channelId = args.channelId as string | undefined
        const channelName = args.channelName as string | undefined
        const limitRaw = Number(args.limit ?? 50)
        const includeBots = Boolean(args.includeBots ?? false)
        const before = args.before as string | undefined
        const after = args.after as string | undefined

        const limit =
          Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100
            ? limitRaw
            : 50

        const guild = await resolveGuild(client, context)

        let channel: GuildBasedChannel | undefined
        if (channelId) {
          channel = guild.channels.cache.get(channelId)
        }
        if (!channel && channelName) {
          channel = findChannelByName(
            guild.channels.cache.values(),
            channelName
          )
        }
        if (!channel && !channelId && !channelName) {
          channel = guild.channels.cache.get(context.channelId)
        }

        if (!channel) {
          return { success: false, message: '채널을 찾을 수 없어요.' }
        }

        if (!isReadableChannel(channel)) {
          return {
            success: false,
            message: '이 채널에서는 메시지를 읽을 수 없어요.',
          }
        }

        const me = guild.members.me
        if (me) {
          const perms = channel.permissionsFor(me)
          if (perms && !perms.has(PermissionFlagsBits.ViewChannel)) {
            return { success: false, message: '봇이 해당 채널을 볼 수 없어요.' }
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

        const fetched = await channel.messages.fetch(fetchOptions)

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
              channel: { id: channel.id, name: channel.name },
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
          message: `#${channel.name} 채널의 메시지 ${messages.length}개를 읽었어요.`,
          data: {
            count: messages.length,
            channel: {
              id: channel.id,
              name: channel.name,
              type:
                channel.type === ChannelType.GuildAnnouncement
                  ? 'announcement'
                  : channel.type === ChannelType.GuildVoice
                  ? 'voice'
                  : channel.type === ChannelType.GuildStageVoice
                  ? 'stage'
                  : 'text',
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
          message: `메시지 읽기 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
