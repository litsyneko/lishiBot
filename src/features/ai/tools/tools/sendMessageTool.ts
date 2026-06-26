import {
  Client,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MessageFlags,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from 'discord.js'
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../toolTypes'

type ChannelLike = {
  id: string
  isTextBased: () => boolean
  send: (options: Record<string, unknown>) => Promise<{ id: string }>
}

type Block =
  | { type: 'text'; content: string }
  | { type: 'title'; content: string }
  | { type: 'separator'; spacing?: 'small' | 'large' }
  | { type: 'images'; items: { url: string; description?: string }[] }
  | { type: 'buttons'; items: { label: string; url: string; style?: string }[] }

export function sendMessageTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'send_message',
      description:
        '특정 채널에 Components V2 메시지를 전송합니다. blocks 배열로 원하는 순서대로 컴포넌트를 자유롭게 배치할 수 있어요. 채널 ID를 생략하면 현재 채널로 전송해요.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: '전송할 채널 ID (비우면 현재 채널)',
          },
          color: {
            type: 'string',
            description: '컨테이너 강조 색상 헥스코드 (예: #FF5733, 선택)',
          },
          blocks: {
            type: 'array',
            description:
              '배치할 컴포넌트 블록 배열. 순서대로 위에서 아래로 렌더링됩니다. 각 블록: { type: "text"|"title"|"separator"|"images"|"buttons", ... }. ' +
              'text: { type:"text", content:"내용" }. ' +
              'title: { type:"title", content:"제목" }. ' +
              'separator: { type:"separator", spacing?:"small"|"large" }. ' +
              'images: { type:"images", items:[{ url, description? }] }. ' +
              'buttons: { type:"buttons", items:[{ label, url, style? }] } (최대 2개 버튼).',
          },
        },
        required: ['blocks'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      try {
        const channelId = (args.channel_id as string | undefined)?.trim() || context.channelId
        const color = (args.color as string | undefined)?.trim()
        const rawBlocks = Array.isArray(args.blocks) ? args.blocks : []

        if (rawBlocks.length === 0) {
          return { success: false, message: '최소 하나 이상의 블록을 배치해 주세요.' }
        }

        const blocks: Block[] = []
        for (const raw of rawBlocks) {
          if (typeof raw !== 'object' || raw === null) continue
          const r = raw as Record<string, unknown>
          const type = typeof r.type === 'string' ? r.type : ''

          if (type === 'text' || type === 'title') {
            const content = String(r.content ?? '').trim()
            if (content) blocks.push({ type, content })
          } else if (type === 'separator') {
            const spacing = r.spacing === 'large' ? 'large' : 'small'
            blocks.push({ type: 'separator', spacing })
          } else if (type === 'images') {
            const items = Array.isArray(r.items) ? r.items : []
            const parsed = items
              .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
              .map((i) => ({
                url: String(i.url ?? '').trim(),
                description: typeof i.description === 'string' ? i.description.trim() : undefined,
              }))
              .filter((i) => i.url)
              .slice(0, 10)
            if (parsed.length > 0) blocks.push({ type: 'images', items: parsed })
          } else if (type === 'buttons') {
            const items = Array.isArray(r.items) ? r.items : []
            const parsed = items
              .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
              .map((i) => ({
                label: String(i.label ?? '').trim(),
                url: String(i.url ?? '').trim(),
                style: typeof i.style === 'string' ? i.style : 'link',
              }))
              .filter((i) => i.label && i.url)
              .slice(0, 2)
            if (parsed.length > 0) blocks.push({ type: 'buttons', items: parsed })
          }
        }

        if (blocks.length === 0) {
          return { success: false, message: '유효한 블록이 없어요.' }
        }

        const channel = client.channels.cache.get(channelId) as ChannelLike | undefined
        if (channel === undefined) {
          return { success: false, message: '채널을 찾을 수 없어요.' }
        }

        if (!channel.isTextBased()) {
          return { success: false, message: '텍스트 채널에만 전송할 수 있어요.' }
        }

        const container = new ContainerBuilder()

        if (color) {
          const hex = color.replace('#', '')
          const parsed = parseInt(hex, 16)
          if (!Number.isNaN(parsed)) {
            container.setAccentColor(parsed)
          }
        }

        for (const block of blocks) {
          if (block.type === 'title') {
            container.addTextDisplayComponents(
              new TextDisplayBuilder().setContent(`### ${block.content}`),
            )
          } else if (block.type === 'text') {
            container.addTextDisplayComponents(
              new TextDisplayBuilder().setContent(block.content),
            )
          } else if (block.type === 'separator') {
            container.addSeparatorComponents(
              new SeparatorBuilder()
                .setDivider(true)
                .setSpacing(
                  block.spacing === 'large'
                    ? SeparatorSpacingSize.Large
                    : SeparatorSpacingSize.Small,
                ),
            )
          } else if (block.type === 'images') {
            const gallery = new MediaGalleryBuilder()
            for (const img of block.items) {
              gallery.addItems({ media: { url: img.url }, description: img.description })
            }
            container.addMediaGalleryComponents(gallery)
          } else if (block.type === 'buttons') {
            const buttonBuilders = block.items.map((b) => {
              const builder = new ButtonBuilder()
                .setLabel(b.label)
                .setURL(b.url)

              if (b.style === 'success') builder.setStyle(ButtonStyle.Success)
              else if (b.style === 'danger') builder.setStyle(ButtonStyle.Danger)
              else if (b.style === 'primary') builder.setStyle(ButtonStyle.Primary)
              else if (b.style === 'secondary') builder.setStyle(ButtonStyle.Secondary)
              else builder.setStyle(ButtonStyle.Link)

              return builder
            })
            const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttonBuilders)
            container.addActionRowComponents(actionRow)
          }
        }

        const sent = await channel.send({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        })

        const targetLabel = channelId === context.channelId ? '현재 채널' : `<#${channelId}>`
        const blockCount = blocks.length
        const summary = `${targetLabel}에 메시지를 전송했어요. (${blockCount}개 블록)`
        return {
          success: true,
          message: summary,
          summary,
          data: { messageId: sent.id, channelId },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `메시지 전송 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
