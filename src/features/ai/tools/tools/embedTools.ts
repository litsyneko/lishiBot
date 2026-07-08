import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolFunctionDeclaration,
  ToolResult,
} from '../toolTypes'
import { Client, EmbedBuilder } from 'discord.js'

type ChannelLike = {
  id: string
  isTextBased: () => boolean
  send: (options: Record<string, unknown>) => Promise<{ id: string }>
}

// draft/send 공통 임베드 파라미터.
const EMBED_PROPERTIES: ToolFunctionDeclaration['parameters']['properties'] = {
  title: { type: 'string', description: '임베드 제목 (최대 256자)' },
  description: { type: 'string', description: '임베드 본문 (최대 4096자)' },
  color: { type: 'string', description: '강조 색상 헥스코드 (예: #5865F2)' },
  fields: {
    type: 'array',
    description:
      '필드 배열. 각 항목 { name, value, inline? }. 최대 25개. 예: [{"name":"항목","value":"내용","inline":true}]',
    items: { type: 'object', description: '{ name, value, inline }' },
  },
  footer: { type: 'string', description: '푸터 텍스트' },
  author: { type: 'string', description: '작성자(상단) 이름' },
  thumbnail_url: { type: 'string', description: '썸네일 이미지 URL' },
  image_url: { type: 'string', description: '큰 이미지 URL' },
  timestamp: { type: 'boolean', description: 'true면 현재 시각 표시' },
}

// args → EmbedBuilder. 최소 제목/설명 중 하나는 있어야 한다.
function buildEmbedFromArgs(
  args: Record<string, unknown>
): EmbedBuilder | { error: string } {
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  const description =
    typeof args.description === 'string' ? args.description.trim() : ''
  if (title.length === 0 && description.length === 0) {
    return { error: '임베드는 최소한 제목이나 설명이 필요해요.' }
  }

  const embed = new EmbedBuilder()
  if (title) embed.setTitle(title.slice(0, 256))
  if (description) embed.setDescription(description.slice(0, 4096))

  const color = typeof args.color === 'string' ? args.color.trim() : ''
  if (color) {
    const parsed = parseInt(color.replace('#', ''), 16)
    if (!Number.isNaN(parsed)) embed.setColor(parsed)
  }

  const rawFields = Array.isArray(args.fields) ? args.fields : []
  const fields = rawFields
    .filter(
      (f): f is Record<string, unknown> => typeof f === 'object' && f !== null
    )
    .map((f) => ({
      name: String(f.name ?? '').slice(0, 256),
      value: String(f.value ?? '').slice(0, 1024),
      inline: f.inline === true,
    }))
    .filter((f) => f.name.length > 0 && f.value.length > 0)
    .slice(0, 25)
  if (fields.length > 0) embed.addFields(fields)

  const footer = typeof args.footer === 'string' ? args.footer.trim() : ''
  if (footer) embed.setFooter({ text: footer.slice(0, 2048) })
  const author = typeof args.author === 'string' ? args.author.trim() : ''
  if (author) embed.setAuthor({ name: author.slice(0, 256) })
  const thumb =
    typeof args.thumbnail_url === 'string' ? args.thumbnail_url.trim() : ''
  if (thumb) embed.setThumbnail(thumb)
  const image = typeof args.image_url === 'string' ? args.image_url.trim() : ''
  if (image) embed.setImage(image)
  if (args.timestamp === true) embed.setTimestamp()

  return embed
}

// 임베드 초안 — 구성만 하고 전송하지 않는다. "이대로 보낼까요?" 확인용.
export function draftEmbedTool(_client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'draft_embed',
      description:
        '임베드(제목/설명/필드/색상/이미지 등)를 초안으로 구성해 미리 보여줍니다. 실제 전송은 하지 않아요. 사용자에게 "이대로 보낼까요?"라고 확인한 뒤 send_embed로 전송하세요.',
      parameters: {
        type: 'object',
        properties: EMBED_PROPERTIES,
        required: [],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'info',
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const built = buildEmbedFromArgs(args)
      if ('error' in built) return { success: false, message: built.error }
      const data = built.toJSON()
      const summary = `임베드 초안을 만들었어요 — 제목: "${
        data.title ?? '(없음)'
      }", 필드 ${
        data.fields?.length ?? 0
      }개. 이대로 보낼까요? (send_embed로 전송)`
      return { success: true, message: summary, data: { embed: data } }
    },
  }
}

// 임베드 전송 — 지정 채널(비우면 현재 채널)에 실제로 보낸다.
export function sendEmbedTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'send_embed',
      description:
        '구성한 임베드를 채널에 실제로 전송합니다. channel_id를 비우면 현재 채널로 보내요. 공개 채널이면 내용에 특히 주의하세요.',
      parameters: {
        type: 'object',
        properties: {
          ...EMBED_PROPERTIES,
          channel_id: {
            type: 'string',
            description: '전송할 채널 ID (비우면 현재 채널)',
          },
        },
        required: [],
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
      const built = buildEmbedFromArgs(args)
      if ('error' in built) return { success: false, message: built.error }

      const channelId =
        (args.channel_id as string | undefined)?.trim() || context.channelId
      const channel = client.channels.cache.get(channelId) as
        | ChannelLike
        | undefined
      if (channel === undefined || !channel.isTextBased()) {
        return { success: false, message: '채널을 찾을 수 없어요.' }
      }

      try {
        const sent = await channel.send({ embeds: [built] })
        const label =
          channelId === context.channelId ? '현재 채널' : `<#${channelId}>`
        return {
          success: true,
          message: `${label}에 임베드를 전송했어요.`,
          data: { messageId: sent.id, channelId },
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { success: false, message: `임베드 전송 중 오류: ${msg}` }
      }
    },
  }
}
