import { resolveGuild } from '../helpers/resolveGuild'
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../toolTypes'
import {
  ChannelType,
  Client,
  type GuildBasedChannel,
  type NonThreadGuildBasedChannel,
} from 'discord.js'

function isNonThreadChannel(
  c: GuildBasedChannel
): c is NonThreadGuildBasedChannel {
  return (
    c.type === ChannelType.GuildText ||
    c.type === ChannelType.GuildVoice ||
    c.type === ChannelType.GuildCategory ||
    c.type === ChannelType.GuildAnnouncement ||
    c.type === ChannelType.GuildForum
  )
}

// ─── listCategoryChannelsTool ───

export function listCategoryChannelsTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'list_category_channels',
      description:
        '서버의 카테고리별 채널 구성을 조회합니다. 각 카테고리 안에 어떤 채널이 어떤 순서로 배치되어 있는지 확인할 수 있어요.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'info',
    },
    async execute(
      _args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const guild = await resolveGuild(client, context)
        const nonThreads = [...guild.channels.cache.values()].filter(
          isNonThreadChannel
        )

        const categories = nonThreads
          .filter((c) => c.type === ChannelType.GuildCategory)
          .sort((a, b) => a.position - b.position)
          .map((cat) => ({
            id: cat.id,
            name: cat.name,
            position: cat.position,
            children: nonThreads
              .filter((c) => c.parentId === cat.id)
              .sort((a, b) => a.position - b.position)
              .map((c) => ({
                id: c.id,
                name: c.name,
                type:
                  c.type === ChannelType.GuildText
                    ? 'text'
                    : c.type === ChannelType.GuildVoice
                    ? 'voice'
                    : 'other',
                position: c.position,
              })),
          }))

        const uncategorized = nonThreads
          .filter((c) => !c.parentId && c.type !== ChannelType.GuildCategory)
          .sort((a, b) => a.position - b.position)
          .map((c) => ({
            id: c.id,
            name: c.name,
            type:
              c.type === ChannelType.GuildText
                ? 'text'
                : c.type === ChannelType.GuildVoice
                ? 'voice'
                : 'other',
            position: c.position,
          }))

        const summaryLines: string[] = []
        for (const cat of categories) {
          summaryLines.push(`### ${cat.name}`)
          if (cat.children.length === 0) {
            summaryLines.push('- (빈 카테고리)')
          } else {
            for (const ch of cat.children) {
              const icon =
                ch.type === 'voice' ? '🔊' : ch.type === 'text' ? '💬' : '📁'
              summaryLines.push(`- ${icon} ${ch.name}`)
            }
          }
        }
        if (uncategorized.length > 0) {
          summaryLines.push('### 분류 없음')
          for (const ch of uncategorized) {
            const icon =
              ch.type === 'voice' ? '🔊' : ch.type === 'text' ? '💬' : '📁'
            summaryLines.push(`- ${icon} ${ch.name}`)
          }
        }

        return {
          success: true,
          message: `카테고리 ${categories.length}개, 분류 없는 채널 ${uncategorized.length}개를 불러왔어요.`,
          data: {
            categoryCount: categories.length,
            categories,
            uncategorizedChannels: uncategorized,
          },
          summary: summaryLines.join('\n'),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `카테고리 조회 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── reorderCategoryChannelsTool ───

export function reorderCategoryChannelsTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'reorder_category_channels',
      description:
        '카테고리 내 채널들의 순서(배치)를 변경합니다. 카테고리 ID와 변경할 채널 ID 배열을 순서대로 지정해 주세요.',
      parameters: {
        type: 'object',
        properties: {
          categoryId: {
            type: 'string',
            description: '순서를 변경할 카테고리 채널의 ID',
          },
          channelIds: {
            type: 'string',
            description:
              '변경할 채널 ID들의 배열을 쉼표로 구분한 문자열 (예: "id1,id2,id3"). 이 순서대로 채널이 정렬돼요.',
          },
        },
        required: ['categoryId', 'channelIds'],
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
        const categoryId = args.categoryId as string | undefined
        const channelIdsRaw = args.channelIds as string | undefined

        if (!categoryId) {
          return { success: false, message: 'categoryId가 필요해요.' }
        }
        if (!channelIdsRaw) {
          return { success: false, message: 'channelIds가 필요해요.' }
        }

        const guild = await resolveGuild(client, context)
        const category = guild.channels.cache.get(categoryId)
        if (!category || category.type !== ChannelType.GuildCategory) {
          return { success: false, message: '해당 카테고리를 찾을 수 없어요.' }
        }

        const ids = channelIdsRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)

        if (ids.length === 0) {
          return {
            success: false,
            message: '최소 하나 이상의 채널 ID가 필요해요.',
          }
        }

        const childChannelIds = new Set(
          [...guild.channels.cache.values()]
            .filter((c) => c.parentId === categoryId)
            .map((c) => c.id)
        )

        const invalidIds = ids.filter((id) => !childChannelIds.has(id))
        if (invalidIds.length > 0) {
          return {
            success: false,
            message: `카테고리에 속하지 않은 채널 ID가 포함되어 있어요: ${invalidIds.join(
              ', '
            )}`,
          }
        }

        const positions = ids.map((id, index) => ({
          channel: id,
          position: index,
        }))

        await guild.channels.setPositions(positions)

        const channelNames = ids
          .map((id) => {
            const ch = guild.channels.cache.get(id)
            return ch ? ch.name : id
          })
          .join(', ')

        return {
          success: true,
          message: `${category.name} 카테고리의 채널 순서를 변경했어요: ${channelNames}`,
          data: { categoryId, categoryName: category.name, positions },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `채널 순서 변경 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── createCategoryTool ───

export function createCategoryTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'create_category',
      description:
        '서버에 새로운 카테고리 채널을 생성합니다. 생성할 카테고리의 이름을 지정해 주세요.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '생성할 카테고리 이름',
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
        const name = args.name as string | undefined
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
          return { success: false, message: '카테고리 이름이 필요해요.' }
        }

        const guild = await resolveGuild(client, context)
        const created = await guild.channels.create({
          name: name.trim(),
          type: ChannelType.GuildCategory,
        })

        return {
          success: true,
          message: `${created.name} 카테고리를 만들었어요!`,
          data: { id: created.id, name: created.name },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `카테고리 생성 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── deleteCategoryTool ───

export function deleteCategoryTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'delete_category',
      description:
        '서버의 카테고리 채널을 삭제합니다. 카테고리 ID로 삭제할 카테고리를 지정해 주세요. 카테고리 내부의 채널들은 uncategorized 상태가 돼요. 서버의 유일한 카테고리는 삭제할 수 없어요.',
      parameters: {
        type: 'object',
        properties: {
          categoryId: {
            type: 'string',
            description: '삭제할 카테고리 채널의 ID',
          },
          categoryName: {
            type: 'string',
            description: '삭제할 카테고리의 이름 (categoryId가 없을 때 사용)',
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
        const categoryId = args.categoryId as string | undefined
        const categoryName = args.categoryName as string | undefined

        if (!categoryId && !categoryName) {
          return {
            success: false,
            message: 'categoryId 또는 categoryName 중 하나는 필요해요.',
          }
        }

        const guild = await resolveGuild(client, context)

        let target: GuildBasedChannel | undefined
        if (categoryId) {
          target = guild.channels.cache.get(categoryId)
        }
        if (!target && categoryName) {
          const lower = categoryName.toLowerCase()
          target = guild.channels.cache.find(
            (c) =>
              c.type === ChannelType.GuildCategory &&
              c.name.toLowerCase() === lower
          )
        }
        if (!target || target.type !== ChannelType.GuildCategory) {
          return { success: false, message: '해당 카테고리를 찾을 수 없어요.' }
        }

        const categories = guild.channels.cache.filter(
          (c) => c.type === ChannelType.GuildCategory
        )
        if (categories.size <= 1) {
          return {
            success: false,
            message: '서버의 유일한 카테고리는 삭제할 수 없어요.',
          }
        }

        const name = target.name
        await guild.channels.delete(target.id)

        return {
          success: true,
          message: `${name} 카테고리를 삭제했어요.`,
          data: { id: target.id, name },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `카테고리 삭제 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
