import { type AiProviderConfig, config } from '../config'
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
import { createAnthropicProvider } from '../features/ai/anthropicProvider'
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
  clearSessionsForChannel,
  clearUserSession,
  getActiveSessionsCount,
  getOrCreateSession,
  getSessionByMessage,
  getUserSessionInfo,
  loadAiSessions,
} from '../features/ai/conversationStore'
import { getMessageImageUrls } from '../features/ai/messageImages'
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
  getServerProfile,
  getSoul,
  getStandingOrders,
  setSoul,
  setStandingOrders,
  upsertServerProfile,
} from '../features/ai/serverProfile'
import { handleSessionReply } from '../features/ai/sessionReply'
import { createStreamRenderer } from '../features/ai/streamRenderer'
import { stripThinkTags, toComponentV2 } from '../features/ai/thinkStripper'
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
  type Message,
  type MessageComponentInteraction,
  type MessageCreateOptions,
  MessageFlags,
  MessageReferenceType,
  type ModalMessageModalSubmitInteraction,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
} from 'discord.js'

// zai-proxy가 가끔 무응답/일시 오류를 내므로 HTTP 요청 단위로 5회까지
// 시도하고, 전부 실패하면 체인이 폴백(gemma4)으로 강등한다. 타임아웃이
// 있어야 "응답이 아예 안 오는" hang도 실패로 집계돼 재시도가 돈다.
const PRIMARY_MAX_ATTEMPTS = 5
const PRIMARY_REQUEST_TIMEOUT_MS = 60_000
// 로컬 gemma4는 CPU 추론(~1.5 tok/s)이라 정상 응답도 수 분 걸릴 수 있어
// 타임아웃을 넉넉히 주고, 재시도는 2회만.
const FALLBACK_MAX_ATTEMPTS = 2
const FALLBACK_REQUEST_TIMEOUT_MS = 600_000

function buildProvider(): ProviderAdapter | undefined {
  const aiConfig = config.ai
  const primaryConfig = aiConfig.primary
  if (primaryConfig === undefined) {
    logger.warn('AI', 'AI provider가 비활성화됨 (dry-run 모드)')
    return undefined
  }

  try {
    const primary = createProviderAdapter(primaryConfig, 'primary')
    const fallbackConfigs = aiConfig.fallbacks ?? []
    const fallbacks: ProviderAdapter[] = []
    const validFallbackDescs: string[] = []

    for (const cfg of fallbackConfigs) {
      try {
        fallbacks.push(createProviderAdapter(cfg, 'fallback'))
        validFallbackDescs.push(describeProvider(cfg))
      } catch (fbErr) {
        logger.warn(
          'AI',
          `폴백 provider(${describeProvider(cfg)}) 초기화 실패, 건너뜁니다: ${
            fbErr instanceof Error ? fbErr.message : String(fbErr)
          }`
        )
      }
    }

    logger.info(
      'AI',
      `AI 두뇌 구성 완료 (primary=${describeProvider(primaryConfig)}${
        validFallbackDescs.length > 0
          ? `, fallbacks=[${validFallbackDescs.join(', ')}]`
          : ''
      }) · 컨텍스트 예산: ${
        config.ai.contextTokens !== undefined
          ? `${config.ai.contextTokens} (config 설정값)`
          : `자동 (primary=${resolveContextTokens(primaryConfig)})`
      }`
    )
    // 체인으로 감싸 primary→fallbacks 순서→dry-run 사과 순으로 우아하게 강등.
    return createAiProviderChain({ primary, fallbacks })
  } catch (error) {
    logger.warn(
      'AI',
      `AI provider 구성 실패 — dry-run 모드로 강등 (${
        error instanceof Error ? error.message : String(error)
      })`
    )
    return undefined
  }
}

function describeProvider(cfg: AiProviderConfig): string {
  const name = cfg.label ?? cfg.provider
  return cfg.baseUrl !== undefined ? `${name}@${cfg.baseUrl}` : name
}

const LOCAL_CONTEXT_TOKENS = 131072 // 128k — 로컬 엔드포인트 기본 컨텍스트 예산
const CLOUD_CONTEXT_TOKENS = 1048576 // 1m — 클라우드 엔드포인트 기본 컨텍스트 예산

// 로컬 추론 모델(gemma4·qwen 등)은 높은 온도에서 도구 호출 인자와 JSON
// 형태가 흔들린다. 잡무용 로컬 두뇌에는 낮은 온도가 안정적이므로 0.2로 고정.
const LOCAL_TEMPERATURE = 0.2

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

function isLocalEndpoint(baseUrl?: string): boolean {
  if (baseUrl === undefined) return false // 미지정 시 OpenCode Zen = 클라우드
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (LOCAL_HOSTNAMES.has(host)) return true
    // 사설 IPv4 대역(10.x / 192.168.x / 172.16-31.x)도 로컬로 본다.
    const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
    if (match === null) return false
    const first = Number(match[1])
    const second = Number(match[2])
    if (first === 10) return true
    if (first === 192 && second === 168) return true
    return first === 172 && second >= 16 && second <= 31
  } catch {
    return false
  }
}

// config에 contextTokens가 있으면 전역 설정값, 없으면 엔드포인트로 자동 감지.
function resolveContextTokens(cfg: AiProviderConfig): number {
  return (
    config.ai.contextTokens ??
    (isLocalEndpoint(cfg.baseUrl) ? LOCAL_CONTEXT_TOKENS : CLOUD_CONTEXT_TOKENS)
  )
}

// config에 temperature가 있으면 그 값, 없으면 로컬 엔드포인트만 0.2.
// 클라우드는 undefined를 돌려줘 SDK/엔드포인트 기본값에 맡긴다.
function resolveTemperature(cfg: AiProviderConfig): number | undefined {
  return (
    cfg.temperature ??
    (isLocalEndpoint(cfg.baseUrl) ? LOCAL_TEMPERATURE : undefined)
  )
}

function createProviderAdapter(
  cfg: AiProviderConfig,
  role: 'primary' | 'fallback'
): ProviderAdapter {
  switch (cfg.provider) {
    case 'anthropic': {
      if (cfg.apiKey === undefined || cfg.apiKey.trim().length === 0) {
        throw new Error(
          `anthropic provider에는 apiKey가 필요합니다 (model=${cfg.model})`
        )
      }
      return createAnthropicProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        contextTokens: resolveContextTokens(cfg),
      })
    }
    case 'openai-compatible':
      return createOpencodeZenProvider({
        apiKey: cfg.apiKey ?? '',
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        label: cfg.label ?? cfg.model,
        reasoningEffort: cfg.reasoningEffort,
        temperature: resolveTemperature(cfg),
        contextTokens: resolveContextTokens(cfg),
        maxAttempts:
          role === 'primary' ? PRIMARY_MAX_ATTEMPTS : FALLBACK_MAX_ATTEMPTS,
        requestTimeoutMs:
          role === 'primary'
            ? PRIMARY_REQUEST_TIMEOUT_MS
            : FALLBACK_REQUEST_TIMEOUT_MS,
      })
    default:
      throw new Error(
        `지원하지 않거나 누락된 provider입니다: ${String(
          (cfg as { provider?: unknown }).provider
        )}`
      )
  }
}

const agentGroup = new SubCommandGroup({
  name: '에이전트',
  description: 'AI 에이전트 상태 확인 및 서버별 설정 관리',
})

const MAX_STANDING_ORDERS = 10

class AiMentionExtensionClass extends Extension {
  private provider: ProviderAdapter | undefined
  private toolRegistry: ToolRegistry | undefined
  // 승인 대기 중인 위험 도구 제안 (proposalId → 제안). 버튼 인터랙션이 소비한다.
  private pendingApprovals = new Map<string, ApprovalProposal>()
  // `/에이전트 셋업` 패널별 채널 선택 (패널 메시지 ID → 채널 ID)
  private panelSelectedChannel = new Map<string, string | null>()

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
      approvalPending: () => collector.hasPending(),
      ai: {
        botId,
        provider: this.provider,
        tools,
      },
      message: {
        authorBot: message.author.bot,
        content: message.content,
        imageUrls: getMessageImageUrls(message),
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
      openStream: (hooks) =>
        createStreamRenderer({
          onFirstContent: () => {
            // 스트리밍이 화면을 장악하면 단계 메시지는 불필요해진다.
            hooks.onFirstContent()
            if (stageMessageId !== undefined) {
              const staleId = stageMessageId
              stageMessageId = undefined
              void message.channel.messages
                .delete(staleId)
                .catch(() => undefined)
            }
          },
          host: {
            send: async (content) => {
              const v2 = toComponentV2(content)
              const sent = await message.reply({ content: '', ...v2 })
              return {
                edit: async (next) => {
                  const editV2 = toComponentV2(next)
                  await message.channel.messages.edit(sent.id, {
                    content: '',
                    ...editV2,
                  })
                },
                id: sent.id,
              }
            },
            setTyping: () => {
              const channel = message.channel
              if (
                'sendTyping' in channel &&
                typeof channel.sendTyping === 'function'
              ) {
                void channel.sendTyping()
              }
            },
          },
        }),
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

    // 스트리밍 경로에서는 답장이 이미 화면에 있으므로 reply()로 다시 보내지
    // 않는다. 세션 바인딩만 그 메시지 id에 묶는다.
    const streamedMessageId = result.streamedMessageId
    if (streamedMessageId !== undefined && botMessageId === undefined) {
      botMessageId = streamedMessageId
      lastBotResponse = result.aiText
    }

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
      appendToSession(
        sessionKey,
        {
          content: result.enrichedPrompt,
          role: 'user',
          imageUrls: getMessageImageUrls(message),
          authorId: userId,
          sentAt: message.createdAt.toISOString(),
        },
        message.id
      )
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
      const traced = getSessionByMessage(referencedMessageId)
      if (
        traced === undefined ||
        traced.session.guildId !== (message.guild?.id ?? '') ||
        traced.session.channelId !== message.channel.id ||
        traced.session.userId !== message.author.id
      ) {
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
      const imageUrls = getMessageImageUrls(message)
      if (userMessage.length === 0 && imageUrls.length === 0) {
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

      // 스트리밍은 이미 보낸 "답장 생각 중" 메시지를 그대로 이어붙여 편집한다.
      // 새 메시지를 만들지 않으므로 중복 전송이 생기지 않는다.
      const stream = createStreamRenderer({
        host: {
          send: async (content) => {
            const v2 = toComponentV2(content)
            await message.channel.messages.edit(sent.id, {
              content: '',
              ...v2,
            })
            return {
              edit: async (next) => {
                const editV2 = toComponentV2(next)
                await message.channel.messages.edit(sent.id, {
                  content: '',
                  ...editV2,
                })
              },
              id: sent.id,
            }
          },
          setTyping: () => {
            if (
              'sendTyping' in message.channel &&
              typeof message.channel.sendTyping === 'function'
            ) {
              void message.channel.sendTyping()
            }
          },
        },
      })

      const result = await handleSessionReply({
        approvalPending: () => collector.hasPending(),
        guildId: message.guild?.id ?? '',
        userId: message.author.id,
        referencedMessageId,
        previousBotResponse: referencedContent,
        provider: this.provider,
        userMessage: userMessage || '첨부한 이미지를 설명해 주세요.',
        userMessageId: message.id,
        sentAt: message.createdAt.toISOString(),
        imageUrls,
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
        openStream: stream,
      })

      if (result.streamedMessageId !== undefined) {
        // 답장이 이미 thinking 메시지에 실렸으므로 삭제는 이미 확정됐고,
        // 세션만 그 메시지에 묶는다.
        thinkingMessageId = undefined
        appendToSession(
          result.sessionKey,
          { content: result.assistantText, role: 'assistant' },
          result.streamedMessageId
        )
      } else {
        try {
          await message.channel.messages.delete(sent.id)
          thinkingMessageId = undefined
        } catch (err) {
          // already deleted
        }

        const v2 = toComponentV2(result.response)
        const replyMsg = await message.reply({ content: '', ...v2 })
        appendToSession(
          result.sessionKey,
          { content: result.assistantText, role: 'assistant' },
          replyMsg.id
        )
      }

      if (result.toolRecords !== undefined && result.toolRecords.length > 0) {
        appendToToolHistory(result.sessionKey, result.toolRecords)
      }

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
        try {
          await send({
            content:
              '승인 카드를 보내지 못해 작업을 실행하지 않았어요. 잠시 후 다시 요청해 주세요.',
          })
        } catch (noticeError) {
          logger.error(
            'AI',
            `승인 카드 실패 안내 전송 실패: ${
              noticeError instanceof Error
                ? noticeError.message
                : String(noticeError)
            }`
          )
        }
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
      this.panelSelectedChannel.get(interaction.message.id) ?? null
    )
    await interaction.update(buildAgentSettingsPanel(data))
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
    name: '안내',
    description: 'AI와 대화하는 방법과 내 세션 관리 명령을 확인합니다.',
  })
  async agentHelp(i: ChatInputCommandInteraction) {
    await replyEphemeral(
      i,
      [
        '🤖 **AI 대화 안내**',
        '- 메시지 맨 앞에 봇을 멘션하고 질문해 주세요. 이미지를 함께 첨부할 수도 있어요.',
        '- AI 답장에 답장하면 같은 대화를 이어갑니다. 답장 대화는 시작한 사용자만 이어갈 수 있어요.',
        '- `/에이전트 내세션`으로 이 채널의 대화 상태를 확인할 수 있어요.',
        '- `/에이전트 내세션초기화`로 이 채널의 내 대화만 지울 수 있어요.',
        '- `/에이전트 셋업`과 `/에이전트 상태`는 서버 관리자용이에요.',
      ].join('\n')
    )
  }

  @agentGroup.command({
    name: '내세션',
    description: '이 채널에서 내 AI 대화 세션 상태를 확인합니다.',
  })
  async agentMySession(i: ChatInputCommandInteraction) {
    const session = getUserSessionInfo(i.guildId ?? '', i.channelId, i.user.id)
    await replyEphemeral(
      i,
      session === undefined
        ? '이 채널에 진행 중인 AI 대화가 없어요. 봇을 멘션해 시작해 주세요.'
        : `이 채널에 AI 대화가 있어요. 저장된 메시지 ${
            session.messageCount
          }개 · 이미지 ${session.imageCount}개 · 마지막 활동 ${new Date(
            session.lastActivity
          ).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`
    )
  }

  @agentGroup.command({
    name: '내세션초기화',
    description: '이 채널의 내 AI 대화 세션만 초기화합니다.',
  })
  async agentClearMySession(i: ChatInputCommandInteraction) {
    await i.deferReply({ flags: MessageFlags.Ephemeral })
    const cleared = await clearUserSession(
      i.guildId ?? '',
      i.channelId,
      i.user.id
    )
    await i.editReply({
      content: cleared
        ? '이 채널의 내 AI 대화를 초기화했어요. 다음 멘션부터 새 대화로 시작해요.'
        : '이 채널에 초기화할 AI 대화가 없어요.',
    })
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

    const data = await this.buildPanelData(guild.id, null)
    await i.reply(buildAgentSettingsPanel(data))
    const panelMessage = await i.fetchReply()
    this.panelSelectedChannel.set(panelMessage.id, null)
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
        `- 활성 세션: ${activeSessions}개 · 승인 대기: ${pendingCount}건`,
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
    const selected =
      this.panelSelectedChannel.get(interaction.message.id) ?? null

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
        action === AGENT_CFG_ACTIONS.roleChannel
      ) {
        this.panelSelectedChannel.set(
          interaction.message.id,
          interaction.values[0] ?? null
        )
        await this.updatePanel(interaction, guildId)
        return
      }

      if (!interaction.isButton()) return

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
        const cleared = await clearSessionsForChannel(
          guildId,
          interaction.channelId
        )
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
      const errorReply = {
        content: '설정 처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.',
        flags: MessageFlags.Ephemeral,
      } as const
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorReply).catch(() => undefined)
      } else {
        await interaction.reply(errorReply).catch(() => undefined)
      }
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
