import { config } from '../config'
import { CommandAccessError } from '../domain/errors'
import { handleMessageCreate } from '../events/messageCreate'
import type { ProviderAdapter } from '../features/ai/aiPolicy'
import type { ToolDefinitionInput } from '../features/ai/aiPolicy'
import { createAiProviderChain } from '../features/ai/aiProviderChain'
import {
  type AiStage,
  formatStageMessage,
} from '../features/ai/animationMessages'
import {
  APPROVAL_TTL_MS,
  type ApprovalProposal,
  type ProposalCollector,
  createProposalCollector,
} from '../features/ai/approvalGate'
import { getCommandCatalog } from '../features/ai/commandCatalog'
import {
  appendToSession,
  appendToToolHistory,
  bindMessageToSession,
  clearSessionsForChannel,
  getActiveSessionsCount,
  getOrCreateSession,
  loadAiSessions,
} from '../features/ai/conversationStore'
import { createGeminiProvider } from '../features/ai/geminiProvider'
import {
  dismissOnboarding,
  shouldShowOnboarding,
} from '../features/ai/onboarding'
import {
  buildOnboardingCard,
  buildOnboardingResolvedCard,
  parseOnboardingCustomId,
} from '../features/ai/onboardingCard'
import { createOpencodeZenProvider } from '../features/ai/opencodeZenProvider'
import { checkToolPermissionLayer3 } from '../features/ai/permissions/permissionCheck'
import {
  type ApprovalPolicy,
  getServerProfile,
  getStandingOrders,
  setStandingOrders,
  upsertServerProfile,
} from '../features/ai/serverProfile'
import { handleSessionReply } from '../features/ai/sessionReply'
import { stripThinkTags, toComponentV2 } from '../features/ai/thinkStripper'
import { delayBeforeToolCall } from '../features/ai/tools/helpers/toolDelay'
import {
  buildApprovalCard,
  buildResolvedApprovalCard,
  parseApprovalCustomId,
  toolNameMap,
} from '../features/ai/tools/proposalCard'
import { createToolRegistry } from '../features/ai/tools/toolRegistry'
import type {
  ToolExecutionContext,
  ToolRegistry,
} from '../features/ai/tools/toolTypes'
import { logger } from '../utils/logger'
import { requireServerManager } from '../utils/permissions'
import { replyEphemeral, replyPublic } from '../utils/replies'
import {
  Extension,
  SubCommandGroup,
  listener,
  option,
} from '@pikokr/command.ts'
import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  type Message,
  type MessageComponentInteraction,
  MessageFlags,
  MessageReferenceType,
  PermissionFlagsBits,
} from 'discord.js'

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

const agentGroup = new SubCommandGroup({
  name: '에이전트',
  description: 'AI 에이전트 상태 확인 및 서버별 설정 관리',
})

const DANGER_GATE_LABELS: Record<ApprovalPolicy['dangerGate'], string> = {
  admin_only: '관리자만 승인',
  requester: '요청자 본인 승인',
  none: '승인 없이 즉시 실행',
}

class AiMentionExtensionClass extends Extension {
  private provider: ProviderAdapter | undefined
  private toolRegistry: ToolRegistry | undefined
  // 승인 대기 중인 위험 도구 제안 (proposalId → 제안). 버튼 인터랙션이 소비한다.
  private pendingApprovals = new Map<string, ApprovalProposal>()

  private buildToolDefinitions(
    message: Message,
    hasManageGuild: boolean,
    hasAdmin: boolean,
    collector: ProposalCollector
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
          // 승인 게이트: danger 도구는 서버 승인 정책(dangerGate)에 따라 처리한다.
          // 프로필 조회 실패 시 getServerProfile이 안전 기본값(admin_only)을 반환하므로
          // 정책을 못 읽어도 게이트가 열리는 방향으로는 절대 무너지지 않는다.
          if (toolDef.permission.risk === 'danger') {
            const profile = await getServerProfile(context.guildId)
            if (profile.approvalPolicy.dangerGate !== 'none') {
              logger.info(
                'TOOL',
                `위험 도구 보류(승인 대기): ${toolDef.declaration.name}`
              )
              return collector.propose(toolDef, args, context)
            }
            logger.info(
              'TOOL',
              `위험 도구 즉시 실행(정책 none): ${toolDef.declaration.name}`
            )
          }
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
    await loadAiSessions()
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

    // 전달(Forward)된 메시지도 reference를 갖지만 답장이 아니다.
    // 답장(Default 타입)만 봇 메시지 이어가기로 처리하고, 전달은 무시한다.
    const reference = message.reference
    if (reference !== null && reference.type !== MessageReferenceType.Default) {
      return
    }

    const referencedMessage = reference?.messageId ?? undefined

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
    const collector = createProposalCollector()
    const tools = this.buildToolDefinitions(
      message,
      hasManageGuild,
      hasAdmin,
      collector
    )
    const commandCatalog = await getCommandCatalog(message.guild)

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
        commandCatalog,
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
      const sessionKey = getOrCreateSession(guildId, message.channel.id, userId)
      appendToToolHistory(sessionKey, result.toolRecords)
    }

    if (
      botMessageId !== undefined &&
      lastBotResponse !== undefined &&
      result.enrichedPrompt !== undefined &&
      result.aiText !== undefined
    ) {
      const sessionKey = getOrCreateSession(guildId, message.channel.id, userId)
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

    await this.sendApprovalCards(message, collector)

    // 온보딩 안내 — AI 응답을 막지 않고 추가 메시지로 전송
    if (guildId.length > 0) {
      const onboardingStatus = await shouldShowOnboarding(
        guildId,
        hasAdmin || isOwner
      )
      if (onboardingStatus === 'show') {
        try {
          const card = buildOnboardingCard(guildId)
          const ch = message.channel
          if ('send' in ch && typeof ch.send === 'function') {
            await ch.send({ content: '', ...card })
          }
          logger.info('Onboarding', `온보딩 안내 전송: guild=${guildId}`)
        } catch (err) {
          logger.debug(
            'Onboarding',
            `온보딩 카드 전송 실패: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
    }
  }

  private async handleReplyToBotMessage(
    message: Message,
    referencedMessageId: string
  ): Promise<void> {
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

      const collector = createProposalCollector()
      const tools = this.buildToolDefinitions(
        message,
        hasManageGuild,
        hasAdmin,
        collector
      )

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
        commandCatalog: await getCommandCatalog(message.guild),
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

      await this.sendApprovalCards(message, collector)
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

  private pruneExpiredApprovals(): void {
    const now = Date.now()
    for (const [id, proposal] of this.pendingApprovals) {
      if (now - proposal.createdAt > APPROVAL_TTL_MS) {
        this.pendingApprovals.delete(id)
      }
    }
  }

  // generate 종료 후, 보류된 위험 도구 제안들을 승인 카드로 전송하고 대기 목록에 등록한다.
  private async sendApprovalCards(
    message: Message,
    collector: ProposalCollector
  ): Promise<void> {
    const proposals = collector.drain()
    if (proposals.length === 0) return

    this.pruneExpiredApprovals()
    for (const proposal of proposals) {
      try {
        const dangerGate = (await getServerProfile(proposal.context.guildId))
          .approvalPolicy.dangerGate
        const card = buildApprovalCard({
          toolName: proposal.toolName,
          args: proposal.args,
          requesterId: proposal.requesterId,
          proposalId: proposal.id,
          dangerGate,
        })
        await message.reply({ content: '', ...card })
        this.pendingApprovals.set(proposal.id, proposal)
        logger.info(
          'TOOL',
          `승인 카드 전송: ${proposal.toolName} (id=${proposal.id})`
        )
      } catch (err) {
        logger.error(
          'AI',
          `승인 카드 전송 실패: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }

  @listener({ event: 'interactionCreate' })
  async onboardingInteraction(interaction: MessageComponentInteraction) {
    if (!interaction.isButton()) return
    const parsed = parseOnboardingCustomId(interaction.customId)
    if (parsed === undefined) return

    const hasAdmin =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ??
      false
    const isOwner = interaction.guild?.ownerId === interaction.user.id

    if (!hasAdmin && !isOwner) {
      await interaction
        .reply({
          content: '관리자만 온보딩 설정을 할 수 있어요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch((err: unknown) => {
          logger.debug(
            'Onboarding',
            `reply failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      return
    }

    switch (parsed.action) {
      case 'start': {
        try {
          await upsertServerProfile(parsed.guildId, {
            onboardedAt: new Date(),
          })
          await interaction
            .update(
              buildOnboardingResolvedCard(
                '✅ 온보딩 완료! `/에이전트 설정`으로 세부 설정을 변경할 수 있어요.'
              )
            )
            .catch((err: unknown) => {
              logger.debug(
                'Onboarding',
                `card update failed: ${
                  err instanceof Error ? err.message : String(err)
                }`
              )
            })
          logger.info(
            'Onboarding',
            `온보딩 완료: guild=${parsed.guildId} user=${interaction.user.id}`
          )
        } catch (err) {
          logger.error(
            'Onboarding',
            `온보딩 완료 처리 오류: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
          await interaction
            .reply({
              content:
                '온보딩 처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.',
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => undefined)
        }
        break
      }
      case 'dismiss2h': {
        dismissOnboarding(parsed.guildId, '2h')
        await interaction
          .update(buildOnboardingResolvedCard('⏰ 2시간 뒤에 다시 안내할게요.'))
          .catch((err: unknown) => {
            logger.debug(
              'Onboarding',
              `card update failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        break
      }
      case 'dismiss24h': {
        dismissOnboarding(parsed.guildId, '24h')
        await interaction
          .update(
            buildOnboardingResolvedCard('📅 오늘은 더 안내하지 않을게요.')
          )
          .catch((err: unknown) => {
            logger.debug(
              'Onboarding',
              `card update failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        break
      }
      case 'dismissChat': {
        dismissOnboarding(parsed.guildId, 'next_chat')
        await interaction
          .update(
            buildOnboardingResolvedCard(
              '👋 닫았어요. 다음에 말 걸면 다시 안내할게요.'
            )
          )
          .catch((err: unknown) => {
            logger.debug(
              'Onboarding',
              `card update failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        break
      }
    }
  }

  @listener({ event: 'interactionCreate' })
  async approvalInteraction(interaction: MessageComponentInteraction) {
    if (!interaction.isButton()) return
    const parsed = parseApprovalCustomId(interaction.customId)
    if (parsed === undefined) return

    const proposal = this.pendingApprovals.get(parsed.proposalId)
    if (proposal === undefined) {
      await interaction
        .reply({
          content: '이미 처리됐거나 만료된 승인 요청이에요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch((err: unknown) => {
          logger.debug(
            'AI',
            `reply failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      return
    }

    // 결정 주체는 서버 승인 정책을 따른다: admin_only=관리자만, 그 외=요청자 본인.
    // (none 정책은 애초에 제안이 생성되지 않지만, 보류 중 정책이 바뀐 경우 요청자 규칙으로 처리)
    const dangerGate = (await getServerProfile(proposal.context.guildId))
      .approvalPolicy.dangerGate
    if (dangerGate === 'admin_only') {
      const clickerIsAdmin =
        (interaction.memberPermissions?.has(
          PermissionFlagsBits.Administrator
        ) ??
          false) ||
        interaction.guild?.ownerId === interaction.user.id
      if (!clickerIsAdmin) {
        await interaction
          .reply({
            content: '관리자만 이 작업을 승인하거나 거부할 수 있어요.',
            flags: MessageFlags.Ephemeral,
          })
          .catch((err: unknown) => {
            logger.debug(
              'AI',
              `reply failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        return
      }
    } else if (interaction.user.id !== proposal.requesterId) {
      await interaction
        .reply({
          content: '작업을 요청한 분만 결정할 수 있어요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch((err: unknown) => {
          logger.debug(
            'AI',
            `reply failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      return
    }

    // 여기서부터 단일 소비 보장 — 더블클릭/중복 처리를 막기 위해 먼저 제거한다.
    this.pendingApprovals.delete(parsed.proposalId)

    const resolveCard = (statusLine: string) =>
      buildResolvedApprovalCard({
        toolName: proposal.toolName,
        args: proposal.args,
        requesterId: proposal.requesterId,
        statusLine,
        dangerGate,
      })
    const updateCard = async (statusLine: string) => {
      await interaction
        .update(resolveCard(statusLine))
        .catch((err: unknown) => {
          logger.debug(
            'AI',
            `card update failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        })
    }

    if (parsed.action === 'deny') {
      await updateCard('🚫 거부됨 — 작업을 실행하지 않았어요.')
      // 거부도 도구 결과처럼 세션에 남긴다 — 다음 턴에 모델이 "거부됨"을 인지해 재시도하지 않도록.
      const sessionKey = getOrCreateSession(
        proposal.context.guildId,
        proposal.context.channelId,
        proposal.requesterId
      )
      appendToToolHistory(sessionKey, [
        {
          name: proposal.toolName,
          args: proposal.args,
          result:
            '사용자가 승인 카드에서 이 작업을 거부했어요. 다시 시도하지 마세요.',
          success: false,
        },
      ])
      return
    }

    if (Date.now() - proposal.createdAt > APPROVAL_TTL_MS) {
      await updateCard('⏰ 만료됨 — 필요하면 다시 요청해 주세요.')
      return
    }

    const toolDef = this.toolRegistry?.get(proposal.toolName)
    if (toolDef === undefined) {
      await updateCard('❌ 작업 정보를 찾을 수 없어요.')
      return
    }

    // 승인 시점 권한으로 L3 재검 — 제안 이후 권한이 바뀌었을 수 있다.
    const hasManageGuild =
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ??
      false
    const hasAdmin =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ??
      false
    const executeCheck = checkToolPermissionLayer3(
      toolDef,
      proposal.args,
      proposal.context,
      hasManageGuild,
      hasAdmin
    )
    if (!executeCheck.ok) {
      await updateCard(`⛔ ${executeCheck.reason}`)
      return
    }

    await updateCard('✅ 승인됨 — 실행 중...')

    const displayName = toolNameMap[proposal.toolName] ?? proposal.toolName
    try {
      const result = await toolDef.execute(proposal.args, proposal.context)
      logger.info(
        'TOOL',
        `승인 실행: ${proposal.toolName} 성공=${result.success}`
      )

      // 세션 기록 — getOrCreateSession 경유로 롤오버/만료 규율을 그대로 따른다.
      const sessionKey = getOrCreateSession(
        proposal.context.guildId,
        proposal.context.channelId,
        proposal.requesterId
      )
      appendToToolHistory(sessionKey, [
        {
          name: proposal.toolName,
          args: proposal.args,
          result: result.message,
          success: result.success,
        },
      ])
      appendToSession(sessionKey, {
        content: `[승인] '${displayName}' 작업 실행을 승인함`,
        role: 'user',
      })

      const responseText = result.success
        ? `${result.message}\n\n> 사용: ${displayName}\n\n-# 이 메시지에 답장하면 대화를 이어갈 수 있어요.`
        : `실패했어요: ${result.message}\n\n-# 이 메시지에 답장하면 대화를 이어갈 수 있어요.`
      const v2 = toComponentV2(responseText)
      const followUpMsg = await interaction.followUp({ content: '', ...v2 })
      const sessionContent = responseText
        .split('\n\n-#')[0]
        .split('\n\n> 사용:')[0]
        .trim()
      appendToSession(
        sessionKey,
        { content: sessionContent, role: 'assistant' },
        followUpMsg.id
      )
    } catch (err) {
      logger.error(
        'AI',
        `승인 작업 실행 오류: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      await interaction
        .followUp({ content: '작업 실행 중 오류가 발생했어요.' })
        .catch((followErr: unknown) => {
          logger.debug(
            'AI',
            `followUp failed: ${
              followErr instanceof Error ? followErr.message : String(followErr)
            }`
          )
        })
    }
  }

  // ── /에이전트 서브커맨드 ──

  // requireServerManager는 CommandAccessError를 던지지만 전역 invokeError 핸들러는
  // 로그만 남긴다 — 사용자에게 거부 사유를 알리려면 여기서 흡수해 ephemeral로 응답해야 한다.
  private async guardServerManager(
    i: ChatInputCommandInteraction
  ): Promise<boolean> {
    try {
      requireServerManager(i)
      return true
    } catch (err) {
      if (err instanceof CommandAccessError) {
        await replyEphemeral(i, err.messageForUser)
        return false
      }
      throw err
    }
  }

  @agentGroup.command({
    name: '상태',
    description:
      '관리자: AI 에이전트의 세션·승인 대기·프로필 상태를 확인합니다.',
  })
  async agentStatus(i: ChatInputCommandInteraction) {
    if (!(await this.guardServerManager(i))) return
    const guild = i.guild
    if (guild === null) return

    const profile = await getServerProfile(guild.id)
    const activeSessions = getActiveSessionsCount(guild.id)

    this.pruneExpiredApprovals()
    let pendingCount = 0
    for (const proposal of this.pendingApprovals.values()) {
      if (proposal.context.guildId === guild.id) pendingCount++
    }

    const channelRoleEntries = Object.entries(profile.channelRoles)
    const channelLines =
      channelRoleEntries.length > 0
        ? channelRoleEntries
            .slice(0, 5)
            .map(([channelId, purpose]) => `  - <#${channelId}>: ${purpose}`)
            .join('\n') +
          (channelRoleEntries.length > 5
            ? `\n  - …외 ${channelRoleEntries.length - 5}개`
            : '')
        : '  - 없음'
    const onboardingLine =
      profile.onboardedAt !== null
        ? `완료 (${profile.onboardedAt.toLocaleDateString('ko-KR', {
            timeZone: 'Asia/Seoul',
          })})`
        : '미완료'

    await replyEphemeral(
      i,
      [
        '🤖 **AI 에이전트 상태**',
        `- 활성 세션: ${activeSessions}개`,
        `- 승인 대기 작업: ${pendingCount}건`,
        `- 서버 컨셉: ${profile.concept ?? '미설정'}`,
        `- 위험 작업 승인 정책: ${
          DANGER_GATE_LABELS[profile.approvalPolicy.dangerGate]
        }`,
        '- 채널 용도:',
        channelLines,
        `- 온보딩: ${onboardingLine}`,
      ].join('\n')
    )
  }

  @agentGroup.command({
    name: '설정_컨셉',
    description: '관리자: AI 에이전트가 참고할 서버 컨셉을 설정합니다.',
  })
  async agentSetConcept(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '내용',
      description: '서버 컨셉 설명 (예: 게임 커뮤니티, 스터디 서버)',
      required: true,
      max_length: 500,
    })
    concept: string
  ) {
    if (!(await this.guardServerManager(i))) return
    const guild = i.guild
    if (guild === null) return

    const trimmed = concept.trim()
    if (trimmed.length === 0) {
      await replyEphemeral(i, '컨셉 내용을 입력해 주세요.')
      return
    }

    await upsertServerProfile(guild.id, { concept: trimmed })
    await replyPublic(i, `🎨 서버 컨셉을 설정했어요.\n> ${trimmed}`)
  }

  @agentGroup.command({
    name: '설정_채널',
    description: '관리자: 채널별 용도를 설정해 AI 에이전트가 참고하게 합니다.',
  })
  async agentSetChannel(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Channel,
      name: '채널',
      description: '용도를 지정할 채널',
      required: true,
    })
    _channel: unknown,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '용도',
      description: '채널 용도 설명 (예: 공지 전용, 잡담, 봇 명령어)',
      required: false,
      max_length: 200,
    })
    purpose: string | null,
    @option({
      type: ApplicationCommandOptionType.Boolean,
      name: '삭제',
      description: 'true면 이 채널의 용도 설정을 제거합니다.',
      required: false,
    })
    remove: boolean | null
  ) {
    if (!(await this.guardServerManager(i))) return
    const guild = i.guild
    if (guild === null) return

    const channel = i.options.getChannel('채널', true)
    const profile = await getServerProfile(guild.id)
    const channelRoles = { ...profile.channelRoles }

    if (remove === true) {
      if (channelRoles[channel.id] === undefined) {
        await replyEphemeral(
          i,
          `<#${channel.id}> 채널에는 설정된 용도가 없어요.`
        )
        return
      }
      delete channelRoles[channel.id]
      await upsertServerProfile(guild.id, { channelRoles })
      await replyPublic(i, `🗑️ <#${channel.id}> 채널의 용도 설정을 제거했어요.`)
      return
    }

    const trimmed = purpose?.trim() ?? ''
    if (trimmed.length === 0) {
      await replyEphemeral(
        i,
        '`용도`를 입력하거나, 제거하려면 `삭제` 옵션을 켜 주세요.'
      )
      return
    }

    channelRoles[channel.id] = trimmed
    await upsertServerProfile(guild.id, { channelRoles })
    await replyPublic(
      i,
      `📌 <#${channel.id}> 채널 용도를 설정했어요.\n> ${trimmed}`
    )
  }

  @agentGroup.command({
    name: '설정_지침',
    description:
      '관리자: AI가 이 서버에서 항상 지킬 상시 지침을 추가/조회/초기화합니다.',
  })
  async agentStandingOrders(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '추가',
      description: '새 상시 지침 (예: 공지 채널에서는 잡담하지 말 것)',
      required: false,
      max_length: 300,
    })
    add: string | null,
    @option({
      type: ApplicationCommandOptionType.Boolean,
      name: '초기화',
      description: 'true면 등록된 상시 지침을 모두 삭제합니다.',
      required: false,
    })
    reset: boolean | null
  ) {
    if (!(await this.guardServerManager(i))) return
    const guild = i.guild
    if (guild === null) return

    const profile = await getServerProfile(guild.id)
    const current = getStandingOrders(profile)

    if (reset === true) {
      if (current.length === 0) {
        await replyEphemeral(i, '삭제할 상시 지침이 없어요.')
        return
      }
      await setStandingOrders(guild.id, [])
      await replyPublic(i, '🧹 상시 지침을 모두 삭제했어요.')
      return
    }

    const trimmed = add?.trim() ?? ''
    if (trimmed.length === 0) {
      if (current.length === 0) {
        await replyEphemeral(
          i,
          '등록된 상시 지침이 없어요. `추가` 옵션으로 지침을 넣어 주세요.'
        )
        return
      }
      const list = current.map((o, idx) => `${idx + 1}. ${o}`).join('\n')
      await replyEphemeral(i, `📋 현재 상시 지침\n${list}`)
      return
    }

    const MAX_ORDERS = 10
    if (current.length >= MAX_ORDERS) {
      await replyEphemeral(
        i,
        `상시 지침은 최대 ${MAX_ORDERS}개까지예요. \`초기화\` 후 다시 추가해 주세요.`
      )
      return
    }
    await setStandingOrders(guild.id, [...current, trimmed])
    await replyPublic(i, `📌 상시 지침을 추가했어요.\n> ${trimmed}`)
  }

  @agentGroup.command({
    name: '설정_정책',
    description:
      '관리자: 위험 작업(채널 삭제·추방 등)의 승인 정책을 변경합니다.',
  })
  async agentSetPolicy(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.String,
      name: '승인정책',
      description: '위험 도구 실행 전 승인 방식',
      required: true,
      choices: [
        { name: '관리자만 승인 (기본값)', value: 'admin_only' },
        { name: '요청자 본인 승인', value: 'requester' },
        { name: '승인 없이 즉시 실행 (주의)', value: 'none' },
      ],
    })
    gate: string
  ) {
    if (!(await this.guardServerManager(i))) return
    const guild = i.guild
    if (guild === null) return

    if (gate !== 'admin_only' && gate !== 'requester' && gate !== 'none') {
      await replyEphemeral(i, '알 수 없는 승인 정책이에요.')
      return
    }

    await upsertServerProfile(guild.id, {
      approvalPolicy: { dangerGate: gate },
    })

    const warning =
      gate === 'none'
        ? '\n⚠️ 이제 위험 작업도 확인 없이 바로 실행돼요. 신중하게 사용해 주세요.'
        : ''
    await replyPublic(
      i,
      `🛡️ 위험 작업 승인 정책을 **${DANGER_GATE_LABELS[gate]}**(으)로 변경했어요.${warning}`
    )
  }

  @agentGroup.command({
    name: '세션_초기화',
    description: '관리자: 이 채널의 AI 대화 세션을 모두 초기화합니다.',
  })
  async agentClearSessions(i: ChatInputCommandInteraction) {
    if (!(await this.guardServerManager(i))) return
    const guild = i.guild
    if (guild === null) return

    const cleared = clearSessionsForChannel(guild.id, i.channelId)
    if (cleared === 0) {
      await replyEphemeral(i, '이 채널에는 초기화할 AI 세션이 없어요.')
      return
    }
    await replyPublic(
      i,
      `🧹 이 채널의 AI 세션 ${cleared}개를 초기화했어요. 다음 멘션부터 새 대화로 시작해요.`
    )
  }
}

export const setup = async () => {
  return new AiMentionExtensionClass()
}
