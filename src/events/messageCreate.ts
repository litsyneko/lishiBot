import type {
  AiStreamOpenHooks,
  AiStreamOutput,
  ProviderAdapter,
  StreamResult,
  ToolDefinitionInput,
} from '../features/ai/aiPolicy'
import type { AiStage } from '../features/ai/animationMessages'
import { recoverFabricatedApproval } from '../features/ai/approvalResponse'
import {
  formatToolHistoryForPrompt,
  getHistory,
} from '../features/ai/conversationStore'
import { getMemoryStore } from '../features/ai/memoryStore'
import {
  INTRO_INFO,
  type IntroInfo,
  detectMentionPrompt,
} from '../features/ai/mentionAi'
import { formatServerContextForPrompt } from '../features/ai/serverProfile'
import { KOREAN_SYSTEM_PROMPT } from '../features/ai/systemPrompt'
import {
  stripThinkTags,
  stripToolCallSyntax,
} from '../features/ai/thinkStripper'
import { logger } from '../utils/logger'

export type MessageCreateInput = {
  readonly authorBot: boolean
  readonly content: string
  readonly imageUrls?: readonly string[]
  readonly guildId: string
  readonly userId: string
  readonly hasManageGuild: boolean
  readonly isOwner: boolean
  // 요청자의 핵심 관리 권한 요약(permissionSummary.ts). AI가 작업 가능 여부를 먼저 판단하는 데 쓴다.
  readonly permissionSummary?: string
  readonly replyToBotMessageId?: string | undefined
  readonly memberDisplayName?: string
  readonly guildName?: string
  readonly channelId: string
  readonly channelName?: string
  // 길드에 등록된 슬래시 명령어 안내문 (commandCatalog.ts에서 생성)
  readonly commandCatalog?: string
}

export type MessageCreateAiConfig = {
  readonly botId: string
  readonly provider?: ProviderAdapter | undefined
  readonly tools?: readonly ToolDefinitionInput[]
}

export type MessageReply =
  | { readonly embed: IntroInfo; readonly type: 'embed' }
  | { readonly content: string; readonly type: 'text' }

export type MessageCreateContext = {
  readonly ai: MessageCreateAiConfig
  readonly approvalPending?: () => boolean
  readonly editStage?: (stage: AiStage) => void
  readonly message: MessageCreateInput
  readonly reply: (reply: MessageReply) => void
  readonly sendStage?: (stage: AiStage) => void
  readonly triggerTyping?: () => void
  /**
   * 스트리밍 메시지를 띄울 수 있으면 제공하는 포트. 미지정이면 기존
   * 단계 애니메이션 + generate 경로가 그대로 동작한다(점진적 degrade).
   */
  readonly openStream?:
    | ((hooks: AiStreamOpenHooks) => AiStreamOutput)
    | undefined
}

export type MessageCreateResult = {
  readonly handled: boolean
  readonly sessionContinued: boolean
  readonly sessionKey?: string
  readonly enrichedPrompt?: string
  readonly aiText?: string
  readonly toolRecords?: readonly {
    name: string
    args: Record<string, unknown>
    result: unknown
    success: boolean
  }[]
  /**
   * 스트리밍 메시지 id. 있으면 최종 답장이 이미 이 메시지에 실려 있으므로
   * 호출부는 reply()로 다시 보내지 않고 이 id에 세션을 묶어야 한다.
   */
  readonly streamedMessageId?: string | undefined
}

const FOOTER_HINT = '---\n\n-# 이 메시지에 답장하면 대화를 이어갈 수 있어요.'

const EMPTY_RESPONSE_NOTICE =
  '💭 이번엔 대답을 끝내지 못했어요. 조금 뒤에 다시 물어봐 주세요.'
const LENGTH_CUT_NOTICE =
  '✂️ 응답이 너무 길어 잘렸어요. 질문을 좀 더 짧게 적어주실래요?'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 취소 가능한 단계 애니메이션. 스트리밍이 첫 내용을 띄우면 애니메이션은 더 이상
 * 필요 없으므로 즉시 중단해 메시지를RENAM juggling 없이 정리한다.
 */
type CancellableAnimation = {
  readonly cancel: () => void
  readonly done: Promise<void>
}

function createThinkingAnimation(
  sendStage: (stage: AiStage) => void | Promise<void>,
  editStage: (stage: AiStage) => void | Promise<void>,
  triggerTyping?: () => void,
  totalMs = 2500
): CancellableAnimation {
  const stage1ms = 800
  const stage2ms = 800
  const stage3ms = Math.max(0, totalMs - stage1ms - stage2ms)

  let signalCancel: () => void = () => undefined
  const cancelled = new Promise<void>((resolve) => {
    signalCancel = resolve
  })
  let isCancelled = false

  // 대기가 끝나거나 취소되면 앞으로 진행한다. ms<=0이면 즉시 통과.
  const step = async (ms: number): Promise<boolean> => {
    if (ms <= 0) {
      return !isCancelled
    }
    const outcome = await Promise.race([
      sleep(ms).then(() => 'elapsed' as const),
      cancelled.then(() => 'cancelled' as const),
    ])
    return outcome === 'elapsed' && !isCancelled
  }

  const done = (async () => {
    triggerTyping?.()
    await sendStage('permission')
    if (!(await step(stage1ms))) return

    triggerTyping?.()
    await editStage('understanding')
    if (!(await step(stage2ms))) return

    triggerTyping?.()
    await editStage('generating')
    await step(stage3ms)
  })()

  return {
    cancel: () => {
      isCancelled = true
      signalCancel()
    },
    done: done.catch(() => undefined),
  }
}

export async function handleMessageCreate(
  context: MessageCreateContext
): Promise<MessageCreateResult> {
  if (context.message.authorBot) {
    return { handled: false, sessionContinued: false }
  }

  try {
    const mentionInfo = detectMentionPrompt(
      context.ai.botId,
      context.message.content
    )
    if (mentionInfo === undefined) {
      return { handled: false, sessionContinued: false }
    }

    if (
      mentionInfo.prompt.trim().length === 0 &&
      !context.message.imageUrls?.length
    ) {
      context.reply({ embed: INTRO_INFO, type: 'embed' })
      return { handled: true, sessionContinued: false }
    }

    if (context.ai.provider === undefined) {
      context.reply({
        content:
          'AI 응답이 준비됐어요: dry-run 모드라 실제 작업은 수행하지 않아요.',
        type: 'text',
      })
      return { handled: true, sessionContinued: false }
    }

    // 단계 애니메이션은 스트리밍이 첫 내용을 띄우면 곧바로 취소된다.
    // 그 전까지는 "권한 확인 → 질문 파악" 표시로 첫 토큰까지의 공백을 메운다.
    const animation =
      context.sendStage !== undefined && context.editStage !== undefined
        ? createThinkingAnimation(
            context.sendStage,
            context.editStage,
            context.triggerTyping,
            2500
          )
        : undefined
    const thinkPromise = animation?.done ?? sleep(2500)

    const displayName = context.message.memberDisplayName ?? '사용자'
    const guildName = context.message.guildName ?? '서버'
    const channelName = context.message.channelName ?? '현재 채널'
    const permissionInfo =
      context.message.permissionSummary !== undefined
        ? `(권한: ${context.message.permissionSummary})`
        : context.message.isOwner
        ? '(권한: 서버 주인)'
        : context.message.hasManageGuild
        ? '(권한: 서버 관리자)'
        : '(권한: 일반 유저)'
    const sessionKey = `${context.message.guildId}:${context.message.channelId}:${context.message.userId}`
    const memoryBlock = await getMemoryStore().formatForPrompt(
      context.message.userId
    )
    const personalityBlock = await getMemoryStore().buildPersonalityPrompt(
      context.message.userId
    )
    const question =
      mentionInfo.prompt.trim() || '첨부한 이미지를 설명해 주세요.'
    const contextHeader = `[대화 시작 - 사용자: ${displayName}] ${permissionInfo} (서버: ${guildName}, 채널: #${channelName})\n\n${question}`
    const enrichedPrompt = memoryBlock + contextHeader

    const existingHistory = getHistory(sessionKey)
    const toolHistoryBlock = formatToolHistoryForPrompt(sessionKey)
    const serverContextBlock = await formatServerContextForPrompt(
      context.message.guildId,
      context.message.channelId
    )
    const promptParts = [
      KOREAN_SYSTEM_PROMPT,
      context.message.commandCatalog ?? '',
      serverContextBlock,
      personalityBlock,
      toolHistoryBlock,
    ].filter((part) => part.length > 0)
    const generateOptions = {
      tools: context.ai.tools,
      imageUrls: context.message.imageUrls,
      maxSteps: 20,
      systemPrompt:
        promptParts.length > 1 ? promptParts.join('\n\n') : undefined,
    }

    // 스트리밍이 가능하면 thinking과 본문이 생성되는 내내 메시지가 갱신된다.
    // renderer가 이미 화면에 본문을 띄웠으므로 최종 reply()는 보내지 않고
    // 스트리밍 메시지 id만 돌려준다(이중 전송 방지).
    if (context.openStream !== undefined) {
      const provider = context.ai.provider
      const stream = context.openStream({
        onFirstContent: () => animation?.cancel(),
      })

      // 스트리밍이 예기치 않게 죽으면 기존 generate 경로로 되돌린다. 체인이
      // 마지막까지 보호하므로 여기서는 방어적 처리만 한다. 화면에 반쯤 노출됐을
      // 수 있으므로 되돌린 결과도 같은 스트리밍 메시지에 최종 편집한다.
      const initialResponse: StreamResult = await (async () => {
        try {
          return await provider.stream(
            enrichedPrompt,
            existingHistory,
            generateOptions,
            {
              onReasoning: (delta) => {
                if (!context.approvalPending?.()) stream.appendReasoning(delta)
              },
              onText: (delta) => {
                if (!context.approvalPending?.()) stream.appendText(delta)
              },
              onToolCall: stream.noteToolCall,
              onProviderSwitch: stream.noteProviderSwitch,
            }
          )
        } catch (error) {
          logger.warn(
            'AI',
            `스트리밍 응답 실패(${describeError(error)}) — generate 경로로 폴백`
          )
          const fallback = await provider.generate(
            enrichedPrompt,
            existingHistory,
            generateOptions
          )
          return { ...fallback, reasoning: '', finishReason: undefined }
        }
      })()

      const recovered = await recoverFabricatedApproval(
        provider,
        enrichedPrompt,
        existingHistory,
        generateOptions,
        initialResponse,
        context.approvalPending ?? (() => false)
      )
      const response: StreamResult = {
        ...recovered,
        reasoning: initialResponse.reasoning,
        finishReason: initialResponse.finishReason,
      }

      // 스트리밍 실패 후 generate로 되돌렸다면 reasoning은 없다. 하지만
      // 화면에는 이미 반쯤 노출됐을 수 있으므로 renderer에 그대로 최종
      // 편집을 맡겨 이중 전송을 막는다.
      const approvalPending = context.approvalPending?.() ?? false
      const cleaned = approvalPending
        ? '요청하신 작업은 승인 대기 중이에요. 승인 카드가 표시되면 버튼으로 결정해 주세요.'
        : stripToolCallSyntax(stripThinkTags(response.text))
      const usedTools =
        !approvalPending && response.toolRecords.length > 0
          ? `\n\n> 사용: ${response.toolRecords.map((r) => r.name).join(', ')}`
          : ''
      const finalText =
        cleaned.trim().length > 0
          ? `${cleaned}${usedTools}\n\n${FOOTER_HINT}`
          : describeEmptyResponse(response.finishReason)

      // complete()는 항상 settle 된다. undefined는 "화면에 남은 게 없다"를
      // 뜻하므로 이때만 기존 reply 경로가 문안을 직접 보낸다.
      const streamedMessageId = await stream.complete(finalText)
      await thinkPromise

      if (streamedMessageId === undefined) {
        context.reply({ content: finalText, type: 'text' })
        return {
          handled: true,
          sessionContinued: false,
          sessionKey,
          enrichedPrompt: contextHeader,
          aiText: cleaned,
          toolRecords: response.toolRecords,
        }
      }

      return {
        handled: true,
        sessionContinued: false,
        sessionKey,
        enrichedPrompt: contextHeader,
        aiText: cleaned,
        streamedMessageId,
        toolRecords: response.toolRecords,
      }
    }

    const aiPromise = context.ai.provider.generate(
      enrichedPrompt,
      existingHistory,
      generateOptions
    )

    const [initialResponse] = await Promise.all([aiPromise, thinkPromise])
    const response = await recoverFabricatedApproval(
      context.ai.provider,
      enrichedPrompt,
      existingHistory,
      generateOptions,
      initialResponse,
      context.approvalPending ?? (() => false)
    )

    const approvalPending = context.approvalPending?.() ?? false
    const cleaned = approvalPending
      ? '요청하신 작업은 승인 대기 중이에요. 승인 카드가 표시되면 버튼으로 결정해 주세요.'
      : stripToolCallSyntax(stripThinkTags(response.text))
    const usedTools =
      !approvalPending && response.toolRecords.length > 0
        ? `\n\n> 사용: ${response.toolRecords.map((r) => r.name).join(', ')}`
        : ''
    const finalText =
      cleaned.trim().length > 0
        ? `${cleaned}${usedTools}\n\n${FOOTER_HINT}`
        : describeEmptyResponse()
    context.reply({ content: finalText, type: 'text' })

    return {
      handled: true,
      sessionContinued: false,
      sessionKey,
      enrichedPrompt: contextHeader,
      aiText: cleaned,
      toolRecords: response.toolRecords,
    }
  } catch (error) {
    logger.error('AI', `멘션 응답 생성 실패: ${describeError(error)}`)
    context.reply({
      content:
        '앗, 대답을 만들다가 문제가 생겼어요. 잠시 후에 다시 불러주실 수 있을까요?',
      type: 'text',
    })
    return { handled: true, sessionContinued: false }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 본문이 비었을 때 조용히 빈 메시지를 보내지 않도록 한국어로 설명한다.
 * max_tokens 부족(length)로 잘린 케이스는 원인이 다르므로 구분한다.
 * 실측 재현: thinking이 예산을 다 쓰면 content:"" + finish_reason:"length" +
 * HTTP 200이 돌아온다.
 */
function describeEmptyResponse(finishReason?: string): string {
  if (finishReason === 'length') {
    logger.warn('AI', '빈 응답 감지: finishReason=length (토큰 예산 소진)')
    return LENGTH_CUT_NOTICE
  }
  logger.warn(
    'AI',
    `빈 응답 감지${
      finishReason !== undefined ? `: finishReason=${finishReason}` : ''
    }`
  )
  return EMPTY_RESPONSE_NOTICE
}
