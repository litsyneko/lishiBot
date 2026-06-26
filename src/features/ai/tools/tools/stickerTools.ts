import { Client, StickerFormatType, type Sticker } from 'discord.js'
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../toolTypes'

const ALLOWED_GUILD_ID = '1440598081648328816'

const formatTypeMap: Record<number, string> = {
  [StickerFormatType.PNG]: 'PNG',
  [StickerFormatType.APNG]: 'APNG',
  [StickerFormatType.Lottie]: 'LOTTIE',
  [StickerFormatType.GIF]: 'GIF',
}

export function getStickerTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'get_sticker',
      description:
        '스티커를 이름으로 검색하거나 전체 목록을 조회합니다. 이름을 입력하면 검색하고, 비우면 전체 목록을 반환해요.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '검색할 스티커 이름 (비우면 전체 목록 조회)',
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
    hidden: true,
    async execute(
      args: Record<string, unknown>,
      _context: ToolExecutionContext,
    ): Promise<ToolResult> {
      try {
        const guild = client.guilds.cache.get(ALLOWED_GUILD_ID)
        if (guild === undefined) {
          return { success: false, message: '스티커 서버를 찾을 수 없어요.' }
        }

        const stickers = await guild.stickers.fetch()
        const query = (args.name as string | undefined)?.trim()

        let matched: Sticker[]
        if (query) {
          const lower = query.toLowerCase()
          const exact = stickers.find((s) => s.name.toLowerCase() === lower)
          const partial = stickers.filter((s) => s.name.toLowerCase().includes(lower))
          matched = exact !== undefined ? [exact] : [...partial.values()]
        } else {
          matched = [...stickers.values()]
        }

        if (matched.length === 0) {
          return {
            success: false,
            message: query
              ? `"${query}"에 해당하는 스티커를 찾을 수 없어요.`
              : '사용 가능한 스티커가 없어요.',
          }
        }

        const results = matched.slice(0, 20).map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description ?? '',
          format: formatTypeMap[s.format] ?? 'UNKNOWN',
          url: s.url,
        }))

        const summaryLines = results.map((s) => `- ${s.name}`)
        const total = stickers.size
        const showing = results.length
        const summary = query
          ? `"${query}" 검색 결과 (${showing}/${matched.length}개):\n${summaryLines.join('\n')}`
          : `전체 스티커 목록 (${showing}/${total}개):\n${summaryLines.join('\n')}`

        return {
          success: true,
          message: query
            ? `"${query}" 검색 결과 ${matched.length}개 중 ${showing}개를 찾았어요.`
            : `전체 스티커 ${total}개 중 ${showing}개를 불러왔어요.`,
          data: { count: results.length, total: stickers.size, stickers: results },
          summary,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `스티커 조회 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
