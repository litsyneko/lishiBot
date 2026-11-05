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
import {
  type DamagedResponse,
  classifyDamagedResponse,
} from '../features/ai/damagedResponse'
import { getMemoryStore } from '../features/ai/memoryStore'
import {
  INTRO_INFO,
  type IntroInfo,
  detectMentionPrompt,
} from '../features/ai/mentionAi'
import {
  ToolExecutionInterruptedError,
  abortedTurnFromSignal,
  describeAbortedTurn,
  toolRecordsFromError,
} from '../features/ai/providerErrors'
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
  readonly recentMessages?: string
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
  /**
   * 턴 중단 신호. 중지 버튼·데드라인이 올린 신호가 provider SDK까지 내려간다.
   *
   * 왜 binder(호스트를 등록하는 콜백) 대신 신호 하나만 받는가: 턴을 만드는 쪽이
   * 호출부(AiMentionExtension)이고, 그쪽이 이미 턴 id로 중지 버튼 payload를
   * 직접 조립할 수 있다. 스트리밍 메시지 id는 턴이 만들어진 뒤에야 정해지므로
   * binder를 경유해 되돌려받는 설계는 순환 참조(호스트→컨텍스트→호스트)만
   * 늘린다. 신호는 중단 판정에 필요한 유일한 정보라 이쪽에 그대로 둔다.
   */
  readonly abortSignal?: AbortSignal | undefined
  /**
   * 턴이 살아 있다는 신호(본문 델타·사고 델타·도구 호출마다 호출된다).
   *
   * 호출부는 이것으로 stall 타이머를 리셋한다. 절대 시간 데드라인은 느린 정상
   * 사고까지 베기 때문에, 여기서는 '아무 신호가 없는 경우'만 알린다. 구체적으로
   * 무엇을 받았는지는 알 필요 없다 — 인터페이스가 의도적으로 얇다.
   */
  readonly onActivity?: (() => void) | undefined
}

export type MessageCreateResult = {
  readonly handled: boolean
  readonly sessionContinued: boolean
  readonly sessionKey?: string
  readonly enrichedPrompt?: string
  readonly aiText?: string
  /**
   * 이 응답이 손상됐는지(중단/반복·과장/빈 본문).
   *
   * aiText는 '무엇을 사용자에게 보여줬는가'이고, damaged는 '그걸 세션에 넣어도
   * 되는가'다. 둘을 분리하는 이유 — 손상 응답도 화면에는 보여야 하므로 aiText를
   * 비우면 안 된다. 그렇다고 손상 텍스트를 세션에 넣으면 다음 턴의 모델이 자기
   * 루프를 대화 기록으로 보고 반복을 이어가므로, 저장 판단은 호출부가 이 플래그로
   * 내리는 게 옳다. aiText를 아예 빼버리는 방식(중단 시 undefined)으로 숨기면
   * 호출부가 '비었다'는 사실과 '저금하면 안 된다'는 사실을 구분할 수 없고,
   * 같은 블록에 묶인 user 턴 저장이 함께 사라진다.
   */
  readonly damaged?: DamagedResponse
  /**
   * 중단 시점까지의 사고 요약(최근 500자). 중단된 턴에서만 의미가 있다.
   * 호출부는 damaged 마커와 함께 세션에 남겨 "AI가 뭘 하다 멈췄는지"를
   * 복원할 수 있게 한다. 정상 응답에서는 빈 문자열이다.
   */
  readonly reasoningSummary?: string
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
 * 턴이 중단됐는지. provider가 이미 멈춘 뒤에도 마지막 델타가 한두 개 더
 * 도착할 수 있으므로, 델타를 화면에 넘기기 직전에 확인한다. 이 가드가 없으면
 * 사용자가 "멈췄어요"를 본 뒤에 글자가 더 붙는 모순이 생긴다.
 */
function isTurnStopped(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
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

  // 예외로 여기까지 왔을 때 세션에 남길 질문(F5). 질문이 만들어지기 전(멘션 아님
  // 등)이면 undefined여서 아무것도 남기지 않는다.
  let recordedUserTurn: string | undefined

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
    const { memoryBlock, personalityBlock } =
      await getMemoryStore().promptBlocks(context.message.userId)
    const question =
      mentionInfo.prompt.trim() || '첨부한 이미지를 설명해 주세요.'
    const contextHeader = `[대화 시작 - 사용자: ${displayName}] ${permissionInfo} (서버: ${guildName}, 채널: #${channelName})\n\n${question}`
    const enrichedPrompt = memoryBlock + contextHeader
    // 질문 문자열을 try 바깥에도 들고 있는 이유(F5): 아래 바깥 catch가
    // 예외를 잡아 제네릭 안내만 보내고 return할 때, 여기까지 온 질문도
    // 세션에 남겨야 한다. 이 변수가 없으면 catch는 enrichedPrompt를 못 만들어
    // 반환하고, 사용자의 질문이 세션에서 통째로 증발한다.
    recordedUserTurn = contextHeader

    const existingHistory = getHistory(sessionKey)
    const toolHistoryBlock = formatToolHistoryForPrompt(sessionKey)
    const serverContextBlock = await formatServerContextForPrompt(
      context.message.guildId,
      context.message.channelId
    )
    const promptParts = [
      KOREAN_SYSTEM_PROMPT,
      context.message.commandCatalog ?? '',
      context.message.recentMessages ?? '',
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
      // 중단 신호를 provider까지 내려간다. 미지정이면 undefined로 흘러
      // 기존과 완전히 동일하게 동작한다.
      abortSignal: context.abortSignal,
    }

    // 스트리밍이 가능하면 thinking과 본문이 생성되는 내내 메시지가 갱신된다.
    // renderer가 이미 화면에 본문을 띄웠으므로 최종 reply()는 보내지 않고
    // 스트리밍 메시지 id만 돌려준다(이중 전송 방지).
    if (context.openStream !== undefined) {
      const provider = context.ai.provider
      const stream = context.openStream({
        onFirstContent: () => animation?.cancel(),
      })
      // 이 블록의 모든 종료 경로(정상 return, 예외 전파)를 finally 하나로 덮는다.
      // complete()는 정상 종결 때만 호출되므로 그 밖의 경로(폴백 generate가 던지는
      // 경우 포함)에서는 타이핑 keepalive 인터벌이 남는다. dispose()가 그 자원을
      // 강제로 닫는다 — 완료를 '기억'하는 대신 해제를 '강제'하는 장치.
      try {
        // 중단 여부는 예외에서만 알 수 있으므로 바깥 변수로 끌어온다. 문구 문자열
        // 비교로 판정하면 AI가 같은 문구를 지어낼 때 오탐한다.
        let aborted = false

        // 스트리밍이 예기치 않게 죽으면 기존 generate 경로로 되돌린다. 체인이
        // 마지막까지 보호하므로 여기서는 방어적 처리만 한다. 화면에 반쯤 노출됐을
        // 수 있으므로 되돌린 결과도 같은 스트리밍 메시지에 최종 편집한다.
        //
        // 단, 중단은 예외가 아니다. generate로 재실행하면 사용자가 멈췄는데 AI가
        // 알아서 답을 끝까지 써버리므로, 중단일 때는 generate를 부르지 않고
        // 중단 결과로 빠져나간다.
        const initialResponse: StreamResult = await (async () => {
          try {
            return await provider.stream(
              enrichedPrompt,
              existingHistory,
              generateOptions,
              {
                onReasoning: (delta) => {
                  // 사고 델타도 '진행'이다. slow 사고(정상)와 hang(응답 없음)을
                  // 구분하는 유일한 신호가 이 이벤트다.
                  context.onActivity?.()
                  if (isTurnStopped(context.abortSignal)) return
                  if (!context.approvalPending?.())
                    stream.appendReasoning(delta)
                },
                onText: (delta) => {
                  context.onActivity?.()
                  if (isTurnStopped(context.abortSignal)) return
                  if (!context.approvalPending?.()) stream.appendText(delta)
                },
                onToolCall: (name) => {
                  // 도구 호출도 진행이다. 도구가 오래 걸리는 구간을 stall이
                  // 잘못 자르지 않아야 한다.
                  context.onActivity?.()
                  stream.noteToolCall(name)
                },
                onProviderSwitch: stream.noteProviderSwitch,
              }
            )
          } catch (error) {
            const interruption = abortedTurnFromSignal(
              error,
              context.abortSignal
            )
            const abortNotice = describeAbortedTurn(interruption)
            if (abortNotice === undefined) {
              const toolRecords = toolRecordsFromError(error)
              if (
                error instanceof ToolExecutionInterruptedError ||
                toolRecords.length > 0
              ) {
                return {
                  text: '도구 호출 중 응답이 끊겼어요. 같은 작업을 다시 실행하기 전에 결과를 확인해 주세요.',
                  toolRecords,
                  reasoning: '',
                }
              }
              logger.warn(
                'AI',
                `스트리밍 응답 실패(${describeError(
                  error
                )}) — generate 경로로 폴백`
              )
              const fallback = await provider.generate(
                enrichedPrompt,
                existingHistory,
                generateOptions
              )
              return { ...fallback, reasoning: '', finishReason: undefined }
            }
            // provider가 이미 던져 준 중단 사유를 그대로 살려 둔다. 사용자는
            // 자신이 누른 것인지, 시간이 걸린 것인지 구분해야 한다.
            aborted = true
            logger.info(
              'AI',
              `응답 중단(${describeError(error)}) — generate 미실행`
            )
            return {
              text: abortNotice,
              toolRecords: toolRecordsFromError(interruption),
              reasoning: '',
            }
          }
        })()

        // 중단이면 승인 문구 복구는 하지 않는다. 그 경로는 provider를 다시
        // 부를 수 있어(재시도) 버린 응답을 되살린다.
        const recovered = aborted
          ? initialResponse
          : await recoverFabricatedApproval(
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
        const approvalPending =
          !aborted && (context.approvalPending?.() ?? false)
        const cleaned = approvalPending
          ? '요청하신 작업은 승인 대기 중이에요. 승인 카드가 표시되면 버튼으로 결정해 주세요.'
          : stripToolCallSyntax(stripThinkTags(response.text))
        const usedTools =
          !approvalPending && response.toolRecords.length > 0
            ? `\n\n> 사용: ${response.toolRecords
                .map((r) => r.name)
                .join(', ')}`
            : ''
        const finalText = aborted
          ? cleaned
          : cleaned.trim().length > 0
          ? `${cleaned}${usedTools}\n\n${FOOTER_HINT}`
          : describeEmptyResponse(response.finishReason)

        // complete()는 항상 settle 된다. undefined는 "화면에 남은 게 없다"를
        // 뜻하므로 이때만 기존 reply 경로가 문안을 직접 보낸다.
        // 중단이어도 complete()를 반드시 부른다 — 렌더러 내부의 편집 체인이
        // 여기서 settle되지 않으면 다음 턴의 메시지가 뒤섞인다.
        const reasoningSummary = stream.takeReasoningSummary()
        const streamedMessageId = await stream.complete(finalText, aborted)
        await thinkPromise
        const visibleResponse =
          streamedMessageId !== undefined ? stream.takeFinalText() : finalText
        const aiText = visibleResponse === finalText ? cleaned : visibleResponse

        // 손상 판정은 화면에 확정된 텍스트(cleaned)를 기준으로 한다. 스트리밍
        // 도중의 버퍼 길이로 판정하면 정상 응답을 잘라낸 것처럼 오탐한다.
        const damaged = classifyDamagedResponse({ text: cleaned, aborted })

        if (streamedMessageId === undefined) {
          context.reply({ content: finalText, type: 'text' })
          return {
            handled: true,
            sessionContinued: false,
            sessionKey,
            enrichedPrompt: contextHeader,
            aiText,
            ...(damaged !== undefined ? { damaged } : {}),
            ...(reasoningSummary.length > 0 ? { reasoningSummary } : {}),
            toolRecords: response.toolRecords,
          }
        }

        return {
          handled: true,
          sessionContinued: false,
          sessionKey,
          enrichedPrompt: contextHeader,
          aiText,
          ...(damaged !== undefined ? { damaged } : {}),
          ...(reasoningSummary.length > 0 ? { reasoningSummary } : {}),
          streamedMessageId,
          toolRecords: response.toolRecords,
        }
      } catch (error) {
        const interruption = abortedTurnFromSignal(error, context.abortSignal)
        const abortNotice = describeAbortedTurn(interruption)
        if (abortNotice !== undefined) {
          const reasoningSummary = stream.takeReasoningSummary()
          const streamedMessageId = await stream.complete(abortNotice, true)
          await thinkPromise
          if (streamedMessageId === undefined)
            context.reply({ content: abortNotice, type: 'text' })
          return {
            handled: true,
            sessionContinued: false,
            sessionKey,
            enrichedPrompt: contextHeader,
            aiText: abortNotice,
            damaged: { kind: 'aborted' },
            toolRecords: toolRecordsFromError(interruption),
            ...(reasoningSummary.length > 0 ? { reasoningSummary } : {}),
            ...(streamedMessageId !== undefined ? { streamedMessageId } : {}),
          }
        }
        logger.error('AI', `멘션 응답 생성 실패: ${describeError(error)}`)
        const errorNotice =
          '앗, 대답을 만들다가 문제가 생겼어요. 잠시 후에 다시 불러주실 수 있을까요?'
        const reasoningSummary = stream.takeReasoningSummary()
        const streamedMessageId = await stream.complete(errorNotice, true)
        await thinkPromise
        if (streamedMessageId === undefined) {
          context.reply({ content: errorNotice, type: 'text' })
        }
        return {
          handled: true,
          sessionContinued: false,
          sessionKey,
          enrichedPrompt: contextHeader,
          aiText: '',
          damaged: { kind: 'empty' },
          toolRecords: toolRecordsFromError(error),
          ...(reasoningSummary.length > 0 ? { reasoningSummary } : {}),
          ...(streamedMessageId !== undefined ? { streamedMessageId } : {}),
        }
      } finally {
        stream.dispose()
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

    // generate 경로에도 같은 판정을 건다. 반복은 스트리밍에서만 검출되므로
    // (1단계) 비스트리밍 응답은 원래 검사받지 않았고, 그래서 오염이 이 경로로
    // 그대로 스며든다. 분류기는 텍스트만 보므로 렌더러 없이도 그대로 쓸 수 있다.
    // 중단 여부는 위 catch에서 이미 문구로 바뀌어 내려오므로 여기서는 항상 false.
    const damaged = classifyDamagedResponse({ text: cleaned })

    return {
      handled: true,
      sessionContinued: false,
      sessionKey,
      enrichedPrompt: contextHeader,
      aiText: cleaned,
      ...(damaged !== undefined ? { damaged } : {}),
      toolRecords: response.toolRecords,
    }
  } catch (error) {
    // 비스트리밍(generate) 경로와 스트리밍 경로가 함께 통과하는 지점이다.
    // 중단은 실패가 아니므로 "문제가 생겼어요"로 뭉개지 않고 중단 문구를 낸다.
    const interruption = abortedTurnFromSignal(error, context.abortSignal)
    const abortNotice = describeAbortedTurn(interruption)
    if (abortNotice !== undefined) {
      logger.info('AI', `응답 중단(${describeError(error)})`)
      context.reply({ content: abortNotice, type: 'text' })
      // user 턴을 돌려준다(F5). 중단 응답을 화면에 보냈더라도 사용자가 실제로
      // 보낸 질문은 온전해야 하고, 이게 없으면 세션이 비어 다음 턴이 무의미해진다.
      return {
        handled: true,
        sessionContinued: false,
        toolRecords: toolRecordsFromError(interruption),
        ...(recordedUserTurn !== undefined
          ? {
              enrichedPrompt: recordedUserTurn,
              aiText: abortNotice,
              damaged: { kind: 'aborted' as const },
            }
          : {}),
      }
    }
    logger.error('AI', `멘션 응답 생성 실패: ${describeError(error)}`)
    context.reply({
      content:
        '앗, 대답을 만들다가 문제가 생겼어요. 잠시 후에 다시 불러주실 수 있을까요?',
      type: 'text',
    })
    // 실패한 턴이어도 질문은 남긴다. 이게 F5다 — 예외 경로에서 aiText가 없더라도
    // user 턴은 원문으로 기록되어야 한다.
    return {
      handled: true,
      sessionContinued: false,
      toolRecords: toolRecordsFromError(error),
      ...(recordedUserTurn !== undefined
        ? {
            enrichedPrompt: recordedUserTurn,
            aiText: '',
            damaged: { kind: 'empty' as const },
          }
        : {}),
    }
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
