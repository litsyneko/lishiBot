import { config } from '../config'
import { handleMessageCreate } from '../events/messageCreate'
import type { ProviderAdapter } from '../features/ai/aiPolicy'
import type { ToolDefinitionInput } from '../features/ai/aiPolicy'
import { createAiProviderChain } from '../features/ai/aiProviderChain'
import {
  type AiStage,
  formatStageMessage,
} from '../features/ai/animationMessages'
import {
  appendToSession,
  appendToToolHistory,
  bindMessageToSession,
  getOrCreateSession,
  reviveSession,
} from '../features/ai/conversationStore'
import { createGeminiProvider } from '../features/ai/geminiProvider'
import { createOpencodeZenProvider } from '../features/ai/opencodeZenProvider'
import { checkToolPermissionLayer3 } from '../features/ai/permissions/permissionCheck'
import { handleSessionReply } from '../features/ai/sessionReply'
import { stripThinkTags, toComponentV2 } from '../features/ai/thinkStripper'
import { delayBeforeToolCall } from '../features/ai/tools/helpers/toolDelay'
import { toolNameMap } from '../features/ai/tools/proposalCard'
import { createToolRegistry } from '../features/ai/tools/toolRegistry'
import type {
  ToolExecutionContext,
  ToolRegistry,
} from '../features/ai/tools/toolTypes'
import { logger } from '../utils/logger'
import { Extension, listener } from '@pikokr/command.ts'
import { EmbedBuilder, type Message, PermissionFlagsBits } from 'discord.js'

function buildProvider(): ProviderAdapter | undefined {
  const aiConfig = config.ai

  if (
    aiConfig.geminiApiKey !== undefined &&
    aiConfig.geminiApiKey.trim().length > 0
  ) {
    const gemini = createGeminiProvider({
      apiKey: aiConfig.geminiApiKey,
      model: 'gemini-3.1-flash-lite',
    })

    if (
      aiConfig.provider === 'opencode-zen' &&
      aiConfig.apiKey !== undefined &&
      aiConfig.apiKey.trim().length > 0
    ) {
      const zen = createOpencodeZenProvider({
        apiKey: aiConfig.apiKey,
        model: aiConfig.model,
      })
      logger.info('AI', 'Gemini + OpenCode Zen 체인 구성 완료')
      return createAiProviderChain({ primary: gemini, fallback: zen })
    }

    logger.info('AI', 'Gemini 단일 provider 구성 완료')
    return gemini
  }

  if (
    aiConfig.provider === 'opencode-zen' &&
    aiConfig.apiKey !== undefined &&
    aiConfig.apiKey.trim().length > 0
  ) {
    logger.info('AI', 'OpenCode Zen 단일 provider 구성 완료')
    return createOpencodeZenProvider({
      apiKey: aiConfig.apiKey,
      model: aiConfig.model,
    })
  }

  logger.warn('AI', 'AI provider가 비활성화됨 (dry-run 모드)')
  return undefined
}

type PendingProposal = {
  readonly name: string
  readonly args: Record<string, unknown>
  readonly sessionKey: string
  readonly requesterId: string
  readonly createdAt: number
}

const PROPOSAL_TTL_MS = 5 * 60 * 1000

class AiMentionExtensionClass extends Extension {
  private provider: ProviderAdapter | undefined
  private toolRegistry: ToolRegistry | undefined
  private pendingProposals = new Map<string, PendingProposal>()

  private buildToolDefinitions(
    message: Message,
    hasManageGuild: boolean,
    hasAdmin: boolean
  ): ToolDefinitionInput[] {
    if (this.toolRegistry === undefined) return []

    const context: ToolExecutionContext = {
      guildId: message.guild?.id ?? '',
      guildName: message.guild?.name ?? '',
      userId: message.author.id,
      channelId: message.channel.id,
    }

    const allTools = this.toolRegistry.getAll()
    const result: ToolDefinitionInput[] = []

    for (const toolDef of allTools) {
      const permCheck = checkToolPermissionLayer3(
        toolDef,
        {},
        context,
        hasManageGuild,
        hasAdmin
      )
      if (!permCheck.ok) continue

      result.push({
        name: toolDef.declaration.name,
        description: toolDef.declaration.description,
        parameters: toolDef.declaration.parameters,
        execute: async (args: Record<string, unknown>) => {
          await delayBeforeToolCall()
          const result = await toolDef.execute(args, context)
          return result
        },
      })
    }

    return result
  }

  @listener({ event: 'clientReady' })
  async ready() {
    this.provider = buildProvider()
    this.toolRegistry = createToolRegistry(this.client)
  }

  @listener({ event: 'messageCreate' })
  async messageCreate(message: Message) {
    const botId = this.client.user?.id
    if (botId === undefined) {
      return
    }

    if (message.author.bot) {
      return
    }

    const hasManageGuild =
      message.member?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false
    const isOwner = message.guild?.ownerId === message.author.id

    const referencedMessage = message.reference?.messageId ?? undefined

    if (referencedMessage !== undefined) {
      await this.handleReplyToBotMessage(message, referencedMessage)
      return
    }

    const guildId = message.guild?.id ?? ''
    const userId = message.author.id

    let stageMessageId: string | undefined
    let botMessageId: string | undefined
    let lastBotResponse: string | undefined
    let replyComplete: Promise<void> = Promise.resolve()

    const hasAdmin =
      message.member?.permissions.has(PermissionFlagsBits.Administrator) ??
      false
    const tools = this.buildToolDefinitions(message, hasManageGuild, hasAdmin)

    const result = await handleMessageCreate({
      ai: {
        botId,
        provider: this.provider,
        tools,
      },
      message: {
        authorBot: message.author.bot,
        content: message.content,
        guildId,
        userId,
        hasManageGuild,
        isOwner,
        memberDisplayName:
          message.member?.displayName ?? message.author.displayName,
        guildName: message.guild?.name,
        channelId: message.channel.id,
        channelName: message.channel.isDMBased()
          ? undefined
          : message.channel.name,
      },
      sendStage: async (stage: AiStage) => {
        const sent = await message.reply(formatStageMessage(stage))
        stageMessageId = sent.id
      },
      editStage: async (stage: AiStage) => {
        if (stageMessageId !== undefined) {
          try {
            await message.channel.messages.edit(
              stageMessageId,
              formatStageMessage(stage)
            )
          } catch (err) {
            // message may have been deleted
          }
        }
      },
      triggerTyping: () => {
        const channel = message.channel
        if (
          'sendTyping' in channel &&
          typeof channel.sendTyping === 'function'
        ) {
          void channel.sendTyping()
        }
      },
      reply: (reply) => {
        replyComplete = (async () => {
          if (reply.type === 'embed') {
            const embed = new EmbedBuilder()
              .setTitle(reply.embed.title)
              .setDescription(reply.embed.description)
              .addFields(
                reply.embed.fields.map((f) => ({
                  name: f.name,
                  value: f.value,
                }))
              )
            const sent = await message.reply({ embeds: [embed] })
            botMessageId = sent.id
          } else {
            const cleaned = stripThinkTags(reply.content)
            const v2 = toComponentV2(cleaned)
            const sent = await message.reply({ content: '', ...v2 })
            botMessageId = sent.id
            lastBotResponse = cleaned
              .split('\n\n-#')[0]
              .split('\n\n> 사용:')[0]
              .trim()
          }
          if (stageMessageId !== undefined) {
            try {
              await message.channel.messages.delete(stageMessageId)
            } catch (err) {
              // already deleted
            }
          }
        })()
      },
    })

    await replyComplete

    if (result.toolRecords !== undefined && result.toolRecords.length > 0) {
      const sessionKey = getOrCreateSession(guildId, userId)
      appendToToolHistory(sessionKey, result.toolRecords)
    }

    if (
      botMessageId !== undefined &&
      lastBotResponse !== undefined &&
      result.enrichedPrompt !== undefined &&
      result.aiText !== undefined
    ) {
      const sessionKey = getOrCreateSession(guildId, userId)
      appendToSession(sessionKey, {
        content: result.enrichedPrompt,
        role: 'user',
      })
      appendToSession(
        sessionKey,
        { content: result.aiText, role: 'assistant' },
        botMessageId
      )
    }
  }

  private async handleReplyToBotMessage(
    message: Message,
    referencedMessageId: string
  ): Promise<void> {
    const pendingToolCall = this.pendingProposals.get(referencedMessageId)
    if (pendingToolCall !== undefined && this.toolRegistry !== undefined) {
      this.pendingProposals.delete(referencedMessageId)
      try {
        if (Date.now() - pendingToolCall.createdAt > PROPOSAL_TTL_MS) {
          await message.reply('작업 제안이 만료되었어요. 다시 요청해 주세요.')
          return
        }

        if (message.author.id !== pendingToolCall.requesterId) {
          await message.reply('작업을 요청한 분만 확인하실 수 있어요.')
          return
        }

        const confirmWords = [
          '네',
          '응',
          '그래',
          '넵',
          'yes',
          'ㅇ',
          'ok',
          '좋아',
        ]
        const userText = message.content.trim().toLowerCase()
        const isConfirm = confirmWords.some(
          (w) => userText === w || userText.startsWith(w)
        )

        if (!isConfirm) {
          await message.reply(
            '작업을 취소했어요. 다른 작업이 필요하면 다시 말씀해 주세요.'
          )
          return
        }

        const toolDef = this.toolRegistry.get(pendingToolCall.name)
        if (toolDef === undefined) {
          await message.reply('❌ 작업 정보를 찾을 수 없어요.')
          return
        }

        const sessionKey = pendingToolCall.sessionKey
        reviveSession(sessionKey)

        const context: ToolExecutionContext = {
          guildId: message.guild?.id ?? '',
          guildName: message.guild?.name ?? '',
          userId: message.author.id,
          channelId: message.channel.id,
        }

        const hasManageGuild =
          message.member?.permissions.has(PermissionFlagsBits.ManageGuild) ??
          false
        const hasAdmin =
          message.member?.permissions.has(PermissionFlagsBits.Administrator) ??
          false

        const executeCheck = checkToolPermissionLayer3(
          toolDef,
          pendingToolCall.args,
          context,
          hasManageGuild,
          hasAdmin
        )
        if (!executeCheck.ok) {
          await message.reply(`⛔ ${executeCheck.reason}`)
          return
        }

        const toolDisplayName =
          toolNameMap[pendingToolCall.name] ?? pendingToolCall.name

        const result = await toolDef.execute(pendingToolCall.args, context)
        logger.info(
          'TOOL',
          `제안 승인 실행: ${pendingToolCall.name} 성공=${result.success}`
        )

        const userConfirmContext = `[대화 중 - 사용자: ${
          message.member?.displayName ?? message.author.displayName
        }] ${message.content}`
        appendToSession(sessionKey, {
          content: userConfirmContext,
          role: 'user',
        })

        const responseText = result.success
          ? `${result.message}\n\n> 사용: ${toolDisplayName}\n\n-# 이 메시지에 답장하면 대화를 이어갈 수 있어요.`
          : `실패했어요: ${result.message}\n\n-# 이 메시지에 답장하면 대화를 이어갈 수 있어요.`

        const v2 = toComponentV2(responseText)
        const replyMsg = await message.reply({ content: '', ...v2 })
        const sessionContent = responseText
          .split('\n\n-#')[0]
          .split('\n\n> 사용:')[0]
          .trim()
        appendToSession(
          sessionKey,
          { content: sessionContent, role: 'assistant' },
          replyMsg.id
        )
        return
      } catch (err) {
        logger.error(
          'AI',
          `제안 승인 처리 중 오류: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        await message
          .reply('작업 처리 중 오류가 발생했어요.')
          .catch((err: unknown) => {
            logger.debug(
              'AI',
              `reply failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
      }
    }

    if (this.provider === undefined) {
      return
    }

    let thinkingMessageId: string | undefined

    try {
      const referenced = await message.channel.messages.fetch(
        referencedMessageId
      )
      if (referenced.author.id !== this.client.user?.id) {
        return
      }

      const hasManageGuild =
        message.member?.permissions.has(PermissionFlagsBits.ManageGuild) ??
        false
      const isOwner = message.guild?.ownerId === message.author.id
      const hasAdmin =
        message.member?.permissions.has(PermissionFlagsBits.Administrator) ??
        false

      const userMessage = message.content.replace(/<@!?\d+>/u, '').trim()
      if (userMessage.length === 0) {
        return
      }

      const referencedContent = stripThinkTags(referenced.content)
        .split('\n\n-#')[0]
        .trim()

      const sent = await message.reply(
        '<a:kirakira:1519382939778158784> AI가 답장을 생각하고 있어요..'
      )
      thinkingMessageId = sent.id
      if (
        'sendTyping' in message.channel &&
        typeof message.channel.sendTyping === 'function'
      ) {
        void message.channel.sendTyping()
      }

      const tools = this.buildToolDefinitions(message, hasManageGuild, hasAdmin)

      const result = await handleSessionReply({
        guildId: message.guild?.id ?? '',
        userId: message.author.id,
        referencedMessageId,
        previousBotResponse: referencedContent,
        provider: this.provider,
        userMessage,
        memberDisplayName:
          message.member?.displayName ?? message.author.displayName,
        guildName: message.guild?.name,
        channelId: message.channel.id,
        channelName: message.channel.isDMBased()
          ? undefined
          : message.channel.name,
        hasManageGuild,
        isOwner,
        tools,
      })

      try {
        await message.channel.messages.delete(sent.id)
        thinkingMessageId = undefined
      } catch (err) {
        // already deleted
      }

      if (result.toolRecords !== undefined && result.toolRecords.length > 0) {
        appendToToolHistory(result.sessionKey, result.toolRecords)
      }

      const v2 = toComponentV2(result.response)
      const replyMsg = await message.reply({ content: '', ...v2 })
      bindMessageToSession(result.sessionKey, replyMsg.id)
    } catch (err) {
      logger.error(
        'AI',
        `답장 세션 처리 중 오류: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      if (thinkingMessageId !== undefined) {
        try {
          await message.channel.messages.delete(thinkingMessageId)
        } catch (deleteErr) {
          logger.debug(
            'AI',
            `thinking message cleanup failed: ${
              deleteErr instanceof Error ? deleteErr.message : String(deleteErr)
            }`
          )
        }
      }
      await message
        .reply('AI 답장 처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.')
        .catch((replyErr: unknown) => {
          logger.debug(
            'AI',
            `reply failed: ${
              replyErr instanceof Error ? replyErr.message : String(replyErr)
            }`
          )
        })
    }
  }
}

export const setup = async () => {
  return new AiMentionExtensionClass()
}
