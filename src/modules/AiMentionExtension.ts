import { config } from '../config'
import { CommandAccessError } from '../domain/errors'
import { handleMessageCreate } from '../events/messageCreate'
import {
  AGENT_CFG_ACTIONS,
  AGENT_CFG_MODAL_PREFIX,
  AGENT_CFG_PREFIX,
  type AgentPanelData,
  DANGER_GATE_LABELS,
  buildAgentSettingsPanel,
  buildConceptModal,
  buildOrderAddModal,
  buildRoleModal,
  buildSoulModal,
} from '../features/ai/agentSettingsPanel'
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
import {
  isAnyJobRunning,
  loadAndRegisterAll,
  setCronRunner,
} from '../features/ai/cronScheduler'
import { type CronJob, listCronJobs } from '../features/ai/cronStore'
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
import { summarizeMemberPermissions } from '../features/ai/permissionSummary'
import { checkToolPermissionLayer3 } from '../features/ai/permissions/permissionCheck'
import {
  formatServerContextForPrompt,
  getHeartbeatConfig,
  getServerProfile,
  getSoul,
  getStandingOrders,
  setHeartbeatConfig,
  setSoul,
  setStandingOrders,
  upsertServerProfile,
} from '../features/ai/serverProfile'
import { handleSessionReply } from '../features/ai/sessionReply'
import { KOREAN_SYSTEM_PROMPT } from '../features/ai/systemPrompt'
import {
  stripThinkTags,
  stripToolCallSyntax,
  toComponentV2,
} from '../features/ai/thinkStripper'
import { roleAssignmentIsSensitive } from '../features/ai/tools/helpers/roleRisk'
import { delayBeforeToolCall } from '../features/ai/tools/helpers/toolDelay'
import {
  buildApprovalCard,
  buildResolvedApprovalCard,
  parseApprovalCustomId,
  toolNameMap,
} from '../features/ai/tools/proposalCard'
import { createToolRegistry } from '../features/ai/tools/toolRegistry'
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistry,
} from '../features/ai/tools/toolTypes'
import { logger } from '../utils/logger'
import { requireServerManager } from '../utils/permissions'
import { replyEphemeral } from '../utils/replies'
import { Extension, SubCommandGroup, listener } from '@pikokr/command.ts'
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
  type MessageComponentInteraction,
  type MessageCreateOptions,
  MessageFlags,
  MessageReferenceType,
  type ModalMessageModalSubmitInteraction,
  type ModalSubmitInteraction,
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

const MAX_STANDING_ORDERS = 10

// heartbeat(자동 발화) 파라미터
const HEARTBEAT_POLL_MS = 30 * 60 * 1000 // 30분마다 폴링(게이트 통과 시에만 AI 호출)
const HEARTBEAT_MAX_PER_DAY = 4 // 채널당 하루 자동 발화 상한
const HEARTBEAT_DAY_MS = 24 * 60 * 60 * 1000
const HEARTBEAT_COOLDOWN_MS = 2 * 60 * 60 * 1000 // 발화 후 최소 2시간 쿨다운(연쇄 발화 방지)

class AiMentionExtensionClass extends Extension {
  private provider: ProviderAdapter | undefined
  private toolRegistry: ToolRegistry | undefined
  // 승인 대기 중인 위험 도구 제안 (proposalId → 제안). 버튼 인터랙션이 소비한다.
  private pendingApprovals = new Map<string, ApprovalProposal>()
  // `/에이전트 셋업` 패널에서 채널 용도 편집 대상으로 고른 채널 (guildId → channelId)
  private panelSelectedChannel = new Map<string, string | null>()
  // heartbeat 상태 — 폴링 중복 방지 + 채널별 발화 시각(RAM rate-limit).
  private heartbeatBusy = false
  private readonly heartbeatSpokeAt = new Map<string, number[]>()

  private buildToolDefinitions(
    context: ToolExecutionContext,
    hasManageGuild: boolean,
    hasAdmin: boolean,
    collector: ProposalCollector
  ): ToolDefinitionInput[] {
    if (this.toolRegistry === undefined) return []

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
          // 역할 부여/회수는 정적 risk가 아니라 대상 역할 권한으로 위험도를 동적 판정한다
          // (관리 권한 역할=danger, 색깔 역할=warning 즉시 실행).
          const effectiveRisk = await this.resolveEffectiveRisk(
            toolDef,
            args,
            context
          )
          if (effectiveRisk === 'danger') {
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

  // 도구의 "실효 위험도"를 결정한다. 대부분은 정적 risk 그대로지만,
  // 역할 부여/회수는 대상 역할의 권한으로 동적 판정한다:
  // 관리 권한(Administrator/ManageGuild/ManageRoles 등) 포함 역할 → danger(승인),
  // 색깔·일반 역할 → 정적 warning(즉시 실행). 판정 불가 시 fail-closed로 danger.
  private async resolveEffectiveRisk(
    toolDef: ToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<'info' | 'warning' | 'danger' | undefined> {
    const name = toolDef.declaration.name
    if (name === 'add_role_member' || name === 'remove_role_member') {
      const sensitive = await roleAssignmentIsSensitive(
        this.client,
        context,
        args
      )
      return sensitive ? 'danger' : toolDef.permission.risk ?? 'warning'
    }
    return toolDef.permission.risk
  }

  @listener({ event: 'clientReady' })
  async ready() {
    this.provider = buildProvider()
    this.toolRegistry = createToolRegistry(this.client)
    await loadAiSessions()
    // 실행부 주입 후, DB의 활성 예약을 croner에 재등록(봇 생존 동안만 스케줄).
    setCronRunner((job) => this.runScheduledJob(job))
    await loadAndRegisterAll()
    // heartbeat 폴링 시작. 기본 OFF라 대부분 게이트에서 걸러지고, 실제 AI 호출은 드물다.
    setInterval(() => {
      void this.runHeartbeat()
    }, HEARTBEAT_POLL_MS).unref?.()
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
    const mentionContext: ToolExecutionContext = {
      guildId: message.guild?.id ?? '',
      guildName: message.guild?.name ?? '',
      userId: message.author.id,
      channelId: message.channel.id,
    }
    const tools = this.buildToolDefinitions(
      mentionContext,
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
        permissionSummary: summarizeMemberPermissions(
          message.member?.permissions,
          { isOwner }
        ),
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

    await this.sendApprovalCards((payload) => message.reply(payload), collector)

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
      const replyContext: ToolExecutionContext = {
        guildId: message.guild?.id ?? '',
        guildName: message.guild?.name ?? '',
        userId: message.author.id,
        channelId: message.channel.id,
      }
      const tools = this.buildToolDefinitions(
        replyContext,
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
        permissionSummary: summarizeMemberPermissions(
          message.member?.permissions,
          { isOwner }
        ),
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

      await this.sendApprovalCards(
        (payload) => message.reply(payload),
        collector
      )
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
    send: (payload: MessageCreateOptions) => Promise<Message>,
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
        await send({ content: '', ...card })
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

  // cron 트리거 시 실행: 저장된 요청(prompt)으로 AI 턴을 돌리고 결과를 채널에 전송한다.
  // danger 도구는 여기서도 승인 게이트를 거친다(사람이 승인해야 실제 실행 → fail-safe).
  async runScheduledJob(job: CronJob): Promise<void> {
    if (this.provider === undefined) return
    const prompt =
      typeof job.payload.prompt === 'string' ? job.payload.prompt.trim() : ''
    if (prompt.length === 0) {
      logger.warn('Cron', `예약 id=${job.id}에 실행할 요청이 없어요.`)
      return
    }
    if (job.channelId === null) return

    const guild = this.client.guilds.cache.get(job.guildId)
    if (guild === undefined) return
    const channel = guild.channels.cache.get(job.channelId)
    if (channel === undefined || !channel.isTextBased()) return

    // 등록자 권한으로 도구 노출을 결정(등록자가 못 하는 건 예약으로도 못 함).
    const member = await guild.members.fetch(job.createdBy).catch(() => null)
    const hasManageGuild =
      member?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false
    const hasAdmin =
      member?.permissions.has(PermissionFlagsBits.Administrator) ?? false
    const permissionSummary = summarizeMemberPermissions(member?.permissions, {
      isOwner: guild.ownerId === job.createdBy,
    })

    const context: ToolExecutionContext = {
      guildId: job.guildId,
      guildName: guild.name,
      userId: job.createdBy,
      channelId: job.channelId,
    }
    const collector = createProposalCollector()
    const tools = this.buildToolDefinitions(
      context,
      hasManageGuild,
      hasAdmin,
      collector
    )

    const serverContextBlock = await formatServerContextForPrompt(
      job.guildId,
      job.channelId
    )
    const promptParts = [KOREAN_SYSTEM_PROMPT, serverContextBlock].filter(
      (part) => part.length > 0
    )

    try {
      const result = await this.provider.generate(
        `[예약된 작업 실행 - 등록자 권한: ${permissionSummary}] ${prompt}`,
        [],
        {
          tools,
          maxSteps: 20,
          systemPrompt:
            promptParts.length > 1 ? promptParts.join('\n\n') : undefined,
        }
      )

      const text = stripToolCallSyntax(stripThinkTags(result.text)).trim()
      const body = text.length > 0 ? text : '예약된 작업을 처리했어요.'
      const v2 = toComponentV2(body)
      const sentMsg = await channel.send({ content: '', ...v2 })

      // 등록자 채널 세션에 남겨 답장으로 이어갈 수 있게 한다.
      const sessionKey = getOrCreateSession(
        job.guildId,
        job.channelId,
        job.createdBy
      )
      appendToSession(sessionKey, {
        content: `[예약 실행] ${prompt}`,
        role: 'user',
      })
      appendToSession(
        sessionKey,
        { content: body, role: 'assistant' },
        sentMsg.id
      )
      if (result.toolRecords.length > 0) {
        appendToToolHistory(sessionKey, result.toolRecords)
      }

      // 보류된 danger 도구는 승인 카드로 채널에 전송(사람이 승인해야 실행).
      await this.sendApprovalCards(
        (payload) => channel.send(payload),
        collector
      )
    } catch (err) {
      logger.error(
        'Cron',
        `예약 실행 중 오류 id=${job.id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  // ── Heartbeat: 폴링 → 5중 게이트 → 통과 시에만 AI turn(먼저 말 걸기) ──

  private isQuietHours(): boolean {
    // KST 23~8시엔 자동 발화 금지.
    const hour = Number(
      new Date().toLocaleString('en-US', {
        timeZone: 'Asia/Seoul',
        hour: '2-digit',
        hour12: false,
      })
    )
    if (!Number.isFinite(hour)) return false
    return hour >= 23 || hour < 8
  }

  private canHeartbeatSpeak(channelId: string): boolean {
    const now = Date.now()
    const recent = (this.heartbeatSpokeAt.get(channelId) ?? []).filter(
      (t) => t > now - HEARTBEAT_DAY_MS
    )
    // rate-limit: 하루 상한
    if (recent.length >= HEARTBEAT_MAX_PER_DAY) return false
    // 쿨다운: 마지막 발화로부터 최소 2시간(발화 직후 답장에 연쇄 발화 방지)
    const last = recent.length > 0 ? recent[recent.length - 1] : 0
    if (now - last < HEARTBEAT_COOLDOWN_MS) return false
    return true
  }

  private markHeartbeatSpoke(channelId: string): void {
    const now = Date.now()
    const recent = (this.heartbeatSpokeAt.get(channelId) ?? []).filter(
      (t) => t > now - HEARTBEAT_DAY_MS
    )
    recent.push(now)
    this.heartbeatSpokeAt.set(channelId, recent)
  }

  // 폴링 틱: 값싼 게이트를 먼저 통과해야만 AI turn을 돌린다(폴링 자체는 AI 없음).
  private async runHeartbeat(): Promise<void> {
    if (this.provider === undefined) return
    if (this.heartbeatBusy) return // 이전 폴링이 아직 진행 중이면 스킵
    this.heartbeatBusy = true
    try {
      // 게이트: cron 실행 중이면 이번 틱은 defer(겹발화 방지)
      if (isAnyJobRunning()) return
      // 게이트: 조용 시간대(KST 23~8시)
      if (this.isQuietHours()) return

      for (const guild of this.client.guilds.cache.values()) {
        const profile = await getServerProfile(guild.id)
        const hb = getHeartbeatConfig(profile)
        if (!hb.enabled) continue // 게이트: OFF(기본)
        if (hb.channelId === null) continue // 게이트: 발화 채널 미지정
        if (!this.canHeartbeatSpeak(hb.channelId)) continue // 게이트: rate-limit
        const channel = guild.channels.cache.get(hb.channelId)
        if (channel === undefined || !channel.isTextBased()) continue
        await this.heartbeatSpeak(guild, channel, hb.channelId)
      }
    } catch (err) {
      logger.error(
        'Heartbeat',
        `폴링 오류: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      this.heartbeatBusy = false
    }
  }

  // 실제 발화 판단 AI turn. "먼저 말 걸 이유 없으면 NO_REPLY". 위험 도구는 승인 게이트 그대로.
  private async heartbeatSpeak(
    guild: Guild,
    channel: GuildTextBasedChannel,
    channelId: string
  ): Promise<void> {
    if (this.provider === undefined) return
    const botId = this.client.user?.id ?? ''
    const context: ToolExecutionContext = {
      guildId: guild.id,
      guildName: guild.name,
      userId: botId,
      channelId,
    }
    const collector = createProposalCollector()
    // 자동 발화는 봇 자율 행동이라 관리 권한 없는 도구만 노출(danger는 어차피 승인 게이트).
    const tools = this.buildToolDefinitions(context, false, false, collector)
    const serverContextBlock = await formatServerContextForPrompt(
      guild.id,
      channelId
    )
    const promptParts = [KOREAN_SYSTEM_PROMPT, serverContextBlock].filter(
      (part) => part.length > 0
    )
    const result = await this.provider.generate(
      '지금 이 채널에서 사용자에게 먼저 말을 걸 만한 자연스러운 이유가 있는지 스스로 판단해줘. 먼저 말 걸 이유가 없으면 다른 말 없이 정확히 "NO_REPLY"라고만 답해. 있으면 짧고 자연스럽게 말을 걸어줘.',
      [],
      {
        tools,
        maxSteps: 10,
        systemPrompt:
          promptParts.length > 1 ? promptParts.join('\n\n') : undefined,
      }
    )
    const text = stripToolCallSyntax(stripThinkTags(result.text)).trim()
    // NO_REPLY는 정확히 일치할 때만 무발화(부분 포함 오탐 방지).
    if (text.length === 0 || text.toUpperCase() === 'NO_REPLY') {
      return // 무발화
    }

    const v2 = toComponentV2(text)
    const sentMsg = await channel.send({ content: '', ...v2 })
    this.markHeartbeatSpoke(channelId)

    const sessionKey = getOrCreateSession(guild.id, channelId, botId)
    appendToSession(
      sessionKey,
      { content: text, role: 'assistant' },
      sentMsg.id
    )
    if (result.toolRecords.length > 0) {
      appendToToolHistory(sessionKey, result.toolRecords)
    }
    await this.sendApprovalCards((payload) => channel.send(payload), collector)
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
        await dismissOnboarding(parsed.guildId, '2h')
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
        await dismissOnboarding(parsed.guildId, '24h')
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
        await dismissOnboarding(parsed.guildId, 'next_chat')
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
    // 결정이 끝난 승인 카드는 3초 뒤 자동 제거(채널 정리). 결과는 followUp으로 별도 유지.
    const scheduleCardRemoval = (): void => {
      setTimeout(() => {
        void interaction.message.delete().catch(() => undefined)
      }, 3000)
    }
    const finalizeCard = async (statusLine: string): Promise<void> => {
      await updateCard(statusLine)
      scheduleCardRemoval()
    }

    if (parsed.action === 'deny') {
      await finalizeCard('🚫 거부됨 — 작업을 실행하지 않았어요.')
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
      await finalizeCard('⏰ 만료됨 — 필요하면 다시 요청해 주세요.')
      return
    }

    const toolDef = this.toolRegistry?.get(proposal.toolName)
    if (toolDef === undefined) {
      await finalizeCard('❌ 작업 정보를 찾을 수 없어요.')
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
      await finalizeCard(`⛔ ${executeCheck.reason}`)
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
    // 승인 실행이 끝났으니(성공/실패 무관) 카드는 3초 뒤 제거, 결과 followUp만 남긴다.
    scheduleCardRemoval()
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

  private async buildPanelData(
    guildId: string,
    selectedChannelId: string | null
  ): Promise<AgentPanelData> {
    const profile = await getServerProfile(guildId)
    this.pruneExpiredApprovals()
    let pendingCount = 0
    for (const proposal of this.pendingApprovals.values()) {
      if (proposal.context.guildId === guildId) pendingCount++
    }
    return {
      soul: getSoul(profile),
      concept: profile.concept,
      dangerGate: profile.approvalPolicy.dangerGate,
      heartbeat: getHeartbeatConfig(profile),
      standingOrders: getStandingOrders(profile),
      channelRoles: profile.channelRoles,
      selectedChannelId,
      activeSessions: getActiveSessionsCount(guildId),
      pendingApprovals: pendingCount,
      onboardedAt: profile.onboardedAt,
    }
  }

  private async updatePanel(
    interaction:
      | MessageComponentInteraction
      | ModalMessageModalSubmitInteraction,
    guildId: string
  ): Promise<void> {
    const data = await this.buildPanelData(
      guildId,
      this.panelSelectedChannel.get(guildId) ?? null
    )
    await interaction
      .update(buildAgentSettingsPanel(data))
      .catch((err: unknown) => {
        logger.debug(
          'AI',
          `패널 갱신 실패: ${err instanceof Error ? err.message : String(err)}`
        )
      })
  }

  // 컴포넌트/모달 인터랙션용 관리 권한 검사(관리자·서버관리·오너).
  private canManagePanel(
    interaction: MessageComponentInteraction | ModalSubmitInteraction
  ): boolean {
    return (
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ===
        true ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ===
        true ||
      interaction.guild?.ownerId === interaction.user.id
    )
  }

  @agentGroup.command({
    name: '셋업',
    description:
      '관리자: 에이전트의 정체성(소울)·서버 이해·자율 범위를 설정하는 패널을 엽니다.',
  })
  async agentSetup(i: ChatInputCommandInteraction) {
    if (!(await this.guardServerManager(i))) return
    const guild = i.guild
    if (guild === null) return

    this.panelSelectedChannel.set(guild.id, null)
    const data = await this.buildPanelData(guild.id, null)
    await i.reply(buildAgentSettingsPanel(data))
  }

  @agentGroup.command({
    name: '상태',
    description:
      '관리자: 에이전트가 지금 무엇을 알고 무엇을 하고 있는지 확인합니다.',
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

    const jobs = await listCronJobs(guild.id)
    const enabledJobs = jobs.filter((job) => job.enabled).length
    const hb = getHeartbeatConfig(profile)
    const orders = getStandingOrders(profile)
    const soul = getSoul(profile)

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
    const soulLine =
      soul !== null
        ? soul.length > 120
          ? `${soul.slice(0, 119)}…`
          : soul
        : '미설정'
    const heartbeatLine = hb.enabled
      ? `켜짐${hb.channelId !== null ? ` (<#${hb.channelId}>)` : ''}`
      : '꺼짐'

    await replyEphemeral(
      i,
      [
        '🤖 **AI 에이전트 상태**',
        `- 소울: ${soulLine}`,
        `- 서버 컨셉: ${profile.concept ?? '미설정'}`,
        `- 상시 지침: ${orders.length}개`,
        `- 위험 작업 승인 정책: ${
          DANGER_GATE_LABELS[profile.approvalPolicy.dangerGate]
        }`,
        `- 자동 발화: ${heartbeatLine}`,
        `- 활성 세션: ${activeSessions}개 · 승인 대기: ${pendingCount}건 · 예약: ${enabledJobs}건`,
        '- 채널 용도:',
        channelLines,
        `- 온보딩: ${onboardingLine}`,
        '',
        '-# 설정 변경은 `/에이전트 셋업`에서 할 수 있어요.',
      ].join('\n')
    )
  }

  @listener({ event: 'interactionCreate' })
  async agentConfigInteraction(interaction: MessageComponentInteraction) {
    if (!interaction.isMessageComponent()) return
    if (!interaction.customId.startsWith(AGENT_CFG_PREFIX)) return
    const guild = interaction.guild
    if (guild === null) return

    if (!this.canManagePanel(interaction)) {
      await interaction
        .reply({
          content: '서버 관리 권한이 있는 사용자만 설정을 바꿀 수 있어요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined)
      return
    }

    const action = interaction.customId.slice(AGENT_CFG_PREFIX.length)
    const guildId = guild.id
    const selected = this.panelSelectedChannel.get(guildId) ?? null

    try {
      if (
        interaction.isStringSelectMenu() &&
        action === AGENT_CFG_ACTIONS.policy
      ) {
        const value = interaction.values[0]
        if (
          value === 'admin_only' ||
          value === 'requester' ||
          value === 'none'
        ) {
          await upsertServerProfile(guildId, {
            approvalPolicy: { dangerGate: value },
          })
        }
        await this.updatePanel(interaction, guildId)
        return
      }

      if (
        interaction.isChannelSelectMenu() &&
        action === AGENT_CFG_ACTIONS.hbChannel
      ) {
        const channelId = interaction.values[0] ?? null
        const profile = await getServerProfile(guildId)
        const hb = getHeartbeatConfig(profile)
        await setHeartbeatConfig(guildId, {
          // 채널을 비우면 발화 대상이 없으므로 자동 발화도 끈다.
          enabled: channelId === null ? false : hb.enabled,
          channelId,
        })
        await this.updatePanel(interaction, guildId)
        return
      }

      if (
        interaction.isChannelSelectMenu() &&
        action === AGENT_CFG_ACTIONS.roleChannel
      ) {
        this.panelSelectedChannel.set(guildId, interaction.values[0] ?? null)
        await this.updatePanel(interaction, guildId)
        return
      }

      if (!interaction.isButton()) return

      if (action === AGENT_CFG_ACTIONS.hbToggle) {
        const profile = await getServerProfile(guildId)
        const hb = getHeartbeatConfig(profile)
        if (hb.enabled) {
          await setHeartbeatConfig(guildId, {
            enabled: false,
            channelId: hb.channelId,
          })
        } else {
          // 켤 때 채널 미지정이면 패널을 연 채널로 기본 설정.
          const channelId = hb.channelId ?? interaction.channelId
          await setHeartbeatConfig(guildId, { enabled: true, channelId })
        }
        await this.updatePanel(interaction, guildId)
        return
      }

      if (action === AGENT_CFG_ACTIONS.soulEdit) {
        const profile = await getServerProfile(guildId)
        await interaction.showModal(buildSoulModal(getSoul(profile)))
        return
      }

      if (action === AGENT_CFG_ACTIONS.conceptEdit) {
        const profile = await getServerProfile(guildId)
        await interaction.showModal(buildConceptModal(profile.concept))
        return
      }

      if (action === AGENT_CFG_ACTIONS.orderAdd) {
        const profile = await getServerProfile(guildId)
        if (getStandingOrders(profile).length >= MAX_STANDING_ORDERS) {
          await interaction.reply({
            content: `상시 지침은 최대 ${MAX_STANDING_ORDERS}개까지예요. 비운 뒤 다시 추가해 주세요.`,
            flags: MessageFlags.Ephemeral,
          })
          return
        }
        await interaction.showModal(buildOrderAddModal())
        return
      }

      if (action === AGENT_CFG_ACTIONS.orderClear) {
        await setStandingOrders(guildId, [])
        await this.updatePanel(interaction, guildId)
        return
      }

      if (action === AGENT_CFG_ACTIONS.roleEdit) {
        if (selected === null) {
          await interaction.reply({
            content: '채널을 먼저 선택해 주세요.',
            flags: MessageFlags.Ephemeral,
          })
          return
        }
        const profile = await getServerProfile(guildId)
        await interaction.showModal(
          buildRoleModal(selected, profile.channelRoles[selected])
        )
        return
      }

      if (action === AGENT_CFG_ACTIONS.roleRemove) {
        if (selected === null) {
          await interaction.reply({
            content: '채널을 먼저 선택해 주세요.',
            flags: MessageFlags.Ephemeral,
          })
          return
        }
        const profile = await getServerProfile(guildId)
        const channelRoles = { ...profile.channelRoles }
        if (channelRoles[selected] !== undefined) {
          delete channelRoles[selected]
          await upsertServerProfile(guildId, { channelRoles })
        }
        await this.updatePanel(interaction, guildId)
        return
      }

      if (action === AGENT_CFG_ACTIONS.sessionClear) {
        const cleared = clearSessionsForChannel(guildId, interaction.channelId)
        await this.updatePanel(interaction, guildId)
        await interaction
          .followUp({
            content:
              cleared === 0
                ? '이 채널에는 초기화할 AI 세션이 없어요.'
                : `🧹 이 채널의 AI 세션 ${cleared}개를 초기화했어요. 다음 멘션부터 새 대화로 시작해요.`,
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => undefined)
        return
      }

      if (action === AGENT_CFG_ACTIONS.refresh) {
        await this.updatePanel(interaction, guildId)
        return
      }
    } catch (err) {
      logger.error(
        'AI',
        `에이전트 셋업 패널 오류: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  @listener({ event: 'interactionCreate' })
  async agentConfigModal(interaction: ModalSubmitInteraction) {
    if (!interaction.isModalSubmit()) return
    if (!interaction.customId.startsWith(AGENT_CFG_MODAL_PREFIX)) return
    const guild = interaction.guild
    if (guild === null) return

    if (!this.canManagePanel(interaction)) {
      await interaction
        .reply({
          content: '서버 관리 권한이 있는 사용자만 설정을 바꿀 수 있어요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined)
      return
    }

    const kind = interaction.customId.slice(AGENT_CFG_MODAL_PREFIX.length)
    const value = interaction.fields.getTextInputValue('value').trim()

    try {
      if (kind === 'soul') {
        await setSoul(guild.id, value.length === 0 ? null : value)
      } else if (kind === 'concept') {
        await upsertServerProfile(guild.id, {
          concept: value.length === 0 ? null : value,
        })
      } else if (kind === 'order') {
        if (value.length > 0) {
          const profile = await getServerProfile(guild.id)
          const current = getStandingOrders(profile)
          if (current.length < MAX_STANDING_ORDERS) {
            await setStandingOrders(guild.id, [...current, value])
          }
        }
      } else if (kind.startsWith('role:')) {
        const channelId = kind.slice('role:'.length)
        const profile = await getServerProfile(guild.id)
        const channelRoles = { ...profile.channelRoles }
        if (value.length === 0) {
          delete channelRoles[channelId]
        } else {
          channelRoles[channelId] = value
        }
        await upsertServerProfile(guild.id, { channelRoles })
      } else {
        return
      }

      // 패널에서 연 모달이면 패널을 그 자리에서 갱신, 아니면 짧게 확인만.
      if (interaction.isFromMessage()) {
        await this.updatePanel(interaction, guild.id)
      } else {
        await interaction
          .reply({ content: '저장했어요.', flags: MessageFlags.Ephemeral })
          .catch(() => undefined)
      }
    } catch (err) {
      logger.error(
        'AI',
        `에이전트 설정 모달 오류: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      await interaction
        .reply({
          content: '설정 저장 중 오류가 발생했어요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined)
    }
  }
}

export const setup = async () => {
  return new AiMentionExtensionClass()
}
