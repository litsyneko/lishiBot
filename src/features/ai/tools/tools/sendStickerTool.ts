import { Client } from 'discord.js'
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../toolTypes'

const ALLOWED_GUILD_ID = '1440598081648328816'

export function sendStickerTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'send_sticker',
      description:
        '현재 채널에 스티커를 전송합니다. get_sticker으로 확인한 sticker_id를 사용하세요.',
      parameters: {
        type: 'object',
        properties: {
          sticker_id: {
            type: 'string',
            description: '전송할 스티커의 ID (숫자 문자열)',
          },
          message: {
            type: 'string',
            description: '스티커와 함께 전송할 메시지 (선택)',
          },
        },
        required: ['sticker_id'],
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
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      try {
        const stickerId = (args.sticker_id as string | undefined)?.trim()
        const messageText = (args.message as string | undefined)?.trim()
        if (!stickerId) {
          return { success: false, message: '전송할 스티커 ID를 입력해 주세요.' }
        }

        const channel = client.channels.cache.get(context.channelId)
        if (channel === undefined) {
          return { success: false, message: '채널 정보를 찾을 수 없어요.' }
        }

        if (!channel.isTextBased() || !('send' in channel)) {
          return { success: false, message: '이 채널에는 메시지를 전송할 수 없어요.' }
        }

        const stickerGuild = client.guilds.cache.get(ALLOWED_GUILD_ID)
        if (stickerGuild === undefined) {
          return { success: false, message: '스티커 서버를 찾을 수 없어요.' }
        }

        const stickers = await stickerGuild.stickers.fetch()
        const sticker = stickers.get(stickerId)
        if (sticker === undefined) {
          return { success: false, message: '해당 ID의 스티커를 찾을 수 없어요.' }
        }

        const sentMessage = await channel.send({ content: messageText ?? '', stickers: [stickerId] })

        return {
          success: true,
          message: `${sticker.name} 스티커를 전송했어요.`,
          summary: `${sticker.name} 스티커 전송 완료`,
          data: { messageId: sentMessage.id, stickerName: sticker.name },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `스티커 전송 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
