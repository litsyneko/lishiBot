import { logger } from '../../utils/logger'
import type {
  AiStreamOutput,
  ChatMessage,
  ProviderAdapter,
  StreamResult,
  ToolDefinitionInput,
} from './aiPolicy'
import { recoverFabricatedApproval } from './approvalResponse'
import {
  appendToSession,
  continueSession,
  formatToolHistoryForPrompt,
  getHistory,
  getOrCreateSession,
} from './conversationStore'
import {
  type DamagedResponse,
  classifyDamagedResponse,
} from './damagedResponse'
import { getMemoryStore } from './memoryStore'
import {
  ToolExecutionInterruptedError,
  abortedTurnFromSignal,
  describeAbortedTurn,
  toolRecordsFromError,
} from './providerErrors'
import { formatServerContextForPrompt } from './serverProfile'
import { KOREAN_SYSTEM_PROMPT } from './systemPrompt'
import { stripThinkTags, stripToolCallSyntax } from './thinkStripper'

const FOOTER_HINT = '---\n\n-# 이 메시지에 답장하면 대화를 이어갈 수 있어요.'

export type SessionReplyInput = {
  readonly approvalPending?: () => boolean
  readonly guildId: string
  readonly userId: string
  readonly referencedMessageId: string
  readonly provider: ProviderAdapter
  readonly userMessage: string
  readonly userMessageId?: string
  readonly sentAt?: string
  readonly imageUrls?: readonly string[]
  readonly previousBotResponse: string
  readonly memberDisplayName?: string
  readonly guildName?: string
  readonly channelId: string
  readonly channelName?: string
  readonly hasManageGuild?: boolean
  readonly isOwner?: boolean
  // 요청자의 핵심 관리 권한 요약(permissionSummary.ts). AI가 작업 가능 여부를 먼저 판단하는 데 쓴다.
  readonly permissionSummary?: string
  readonly tools?: readonly ToolDefinitionInput[]
  // 길드에 등록된 슬래시 명령어 안내문 (commandCatalog.ts에서 생성)
  readonly commandCatalog?: string
  readonly recentMessages?: string
  // 스트리밍 출력 포트. 미지정이면 generate 경로로 그대로 동작한다.
  readonly openStream?: AiStreamOutput
  /**
   * 턴 중단 신호(중지 버튼·데드라인). provider SDK까지 내려간다. 미지정이면
   * 중단 없이 끝까지 생성한다.
   */
  readonly abortSignal?: AbortSignal | undefined
  /**
   * 턴이 살아 있다는 신호(본문 델타·사고 델타·도구 호출마다 호출된다).
   * 호출부가 stall 타이머를 리셋하는 데 쓴다.
   */
  readonly onActivity?: (() => void) | undefined
}

export type SessionReplyResult = {
  readonly response: string
  readonly assistantText: string
  readonly continuedFromSession: boolean
  readonly sessionKey: string
  readonly toolRecords?: readonly {
    name: string
    args: Record<string, unknown>
    result: unknown
    success: boolean
  }[]
  /**
   * 스트리밍 메시지 id. 있으면 response가 이미 그 메시지에 실려 있으므로
   * 호출부는 reply()로 다시 보내지 않는다(이중 전송 방지).
   */
  readonly streamedMessageId?: string
  /**
   * 이 응답이 손상됐는지(중단/반복·과장/빈 본문).
   *
   * assistantText는 '무엇을 사용자에게 보여줬는가'이고, damaged는 '그걸 세션에
   * 넣어도 되는가'다. 둘을 분리한다 — 손상 응답도 화면에는 보여야 하므로
   * assistantText를 비우면 안 되고, 그렇다고 그대로 저장하면 다음 턴의 모델이
   * 자기 루프를 대화 기록으로 보고 이어서 반복한다. 저장 판단은 호출부가
   * damaged로 내린다.
   */
  readonly damaged?: DamagedResponse
  /**
   * 중단 시점까지의 사고 요약(최근 500자). 중단된 턴에서만 의미가 있다.
   * 호출부는 damaged 마커와 함께 세션에 남겨 "AI가 뭘 하다 멈췄는지"를
   * 복원할 수 있게 한다. 정상 응답에서는 빈 문자열이다.
   */
  readonly reasoningSummary?: string
  /**
   * 사용자가 중지했거나 데드라인에 걸려 턴이 중단됐는지. 화면 문구 분기에 쓰이며,
   * damaged.kind === 'aborted'와 항상 같다(호환을 위해 유지).
   */
  readonly aborted?: boolean
}

// 본문이 비었을 때 조용히 빈 메시지를 보내지 않도록 한국어로 설명한다.
// thinking이 토큰 예산을 다 써서 content:"" + finish_reason:"length"가 오는
// 경우가 실제로 관측된다.
const EMPTY_RESPONSE_NOTICE =
  '💭 이번엔 대답을 끝내지 못했어요. 조금 뒤에 다시 물어봐 주세요.'
const LENGTH_CUT_NOTICE =
  '✂️ 응답이 너무 길어 잘렸어요. 질문을 좀 더 짧게 적어주실래요?'
const REPLY_ERROR_NOTICE =
  'AI 답장 처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.'

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

/**
 * 턴이 중단됐는지. provider가 이미 멈춘 뒤에도 마지막 델타가 한두 개 더
 * 도착할 수 있으므로, 델타를 화면에 넘기기 직전에 확인한다. 이 가드가 없으면
 * 사용자가 "멈췄어요"를 본 뒤에 글자가 더 붙는 모순이 생긴다.
 */
function isStopped(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export async function handleSessionReply(
  input: SessionReplyInput
): Promise<SessionReplyResult> {
  const {
    guildId,
    userId,
    referencedMessageId,
    provider,
    userMessage,
    previousBotResponse,
  } = input

  let sessionKey: string
  const continued = continueSession(
    referencedMessageId,
    guildId,
    input.channelId,
    userId
  )
  if (continued !== undefined) {
    sessionKey = continued
  } else {
    sessionKey = getOrCreateSession(guildId, input.channelId, userId)
  }

  const stream = input.openStream
  try {
    const displayName = input.memberDisplayName ?? '사용자'
    const guildName = input.guildName ?? '서버'
    const channelName = input.channelName ?? '현재 채널'
    const permissionInfo =
      input.permissionSummary !== undefined
        ? `(권한: ${input.permissionSummary})`
        : input.isOwner
        ? '(권한: 서버 주인)'
        : input.hasManageGuild
        ? '(권한: 서버 관리자)'
        : '(권한: 일반 유저)'
    const contextPrefix = `[대화 중 - 사용자: ${displayName}] ${permissionInfo} (서버: ${guildName}, 채널: #${channelName})\n\n`
    const { memoryBlock, personalityBlock } =
      await getMemoryStore().promptBlocks(userId)
    const contextMessage = memoryBlock + contextPrefix + userMessage

    const history: ChatMessage[] = [
      ...getHistory(sessionKey),
      ...(continued === undefined && previousBotResponse.trim().length > 0
        ? [{ content: previousBotResponse, role: 'assistant' as const }]
        : []),
    ]
    const toolHistoryBlock = formatToolHistoryForPrompt(sessionKey)
    const serverContextBlock = await formatServerContextForPrompt(
      guildId,
      input.channelId
    )
    const promptParts = [
      KOREAN_SYSTEM_PROMPT,
      input.commandCatalog ?? '',
      input.recentMessages ?? '',
      serverContextBlock,
      personalityBlock,
      toolHistoryBlock,
    ].filter((part) => part.length > 0)
    const generateOptions = {
      tools: input.tools,
      imageUrls: input.imageUrls,
      maxSteps: 20,
      systemPrompt:
        promptParts.length > 1 ? promptParts.join('\n\n') : undefined,
      // 중단 신호를 provider까지 내려간다. 미지정이면 undefined로 흘러 기존과
      // 동일하게 동작한다.
      abortSignal: input.abortSignal,
    }

    // 스트리밍 포트가 있으면 스트리밍 경로를, 없으면 기존 generate 경로를 쓴다.
    // 스트리밍이 예기치 않게 죽으면 같은 화면(thinking 메시지)에 generate 결과를
    // 확정 편집하므로 새 메시지가 생기지 않는다.
    let result: StreamResult
    // 중단 여부는 예외에서만 알 수 있으므로 바깥 변수로 끌어온다. 문구 문자열
    // 비교로 판정하면 AI가 같은 문구를 지어낼 때 오탐한다.
    let aborted = false

    // 성공/중단/예외 모두 최종 편집을 끝낸 다음 자원을 해제한다.
    if (stream === undefined) {
      try {
        result = {
          ...(await provider.generate(
            contextMessage,
            history,
            generateOptions
          )),
          reasoning: '',
          finishReason: undefined,
        }
      } catch (error) {
        // generate 경로도 같은 규칙. 중단을 그냥 던지면 호출부가 '오류가
        // 발생했어요'로 뭉개 버리므로, 중단 문구를 응답으로 되돌린다.
        const interruption = abortedTurnFromSignal(error, input.abortSignal)
        const abortNotice = describeAbortedTurn(interruption)
        if (abortNotice === undefined) {
          throw error
        }
        aborted = true
        logger.info('AI', `답장 중단(${abortNotice})`)
        result = {
          text: abortNotice,
          toolRecords: toolRecordsFromError(interruption),
          reasoning: '',
        }
      }
    } else {
      try {
        result = await provider.stream(
          contextMessage,
          history,
          generateOptions,
          {
            onReasoning: (delta) => {
              // 사고 델타도 '진행'이다 — 느린 정상 사고를 stall이 자르지 않게 한다.
              input.onActivity?.()
              if (isStopped(input.abortSignal)) return
              if (!input.approvalPending?.()) stream.appendReasoning(delta)
            },
            onText: (delta) => {
              input.onActivity?.()
              if (isStopped(input.abortSignal)) return
              if (!input.approvalPending?.()) stream.appendText(delta)
            },
            onToolCall: (name) => {
              input.onActivity?.()
              stream.noteToolCall(name)
            },
            onProviderSwitch: stream.noteProviderSwitch,
          }
        )
      } catch (error) {
        // 중단은 예외가 아니라 사용자 의도다. generate로 폴백하면 사용자가
        // 버린 응답을 다른 provider가 통째로 다시 써버리므로 절대 재실행하지 않는다.
        const interruption = abortedTurnFromSignal(error, input.abortSignal)
        const abortNotice = describeAbortedTurn(interruption)
        if (abortNotice !== undefined) {
          aborted = true
          logger.info('AI', `답장 중단(${abortNotice}) — generate 미실행`)
          result = {
            text: abortNotice,
            toolRecords: toolRecordsFromError(interruption),
            reasoning: '',
          }
        } else {
          const toolRecords = toolRecordsFromError(error)
          if (
            error instanceof ToolExecutionInterruptedError ||
            toolRecords.length > 0
          ) {
            result = {
              text: '도구 호출 중 응답이 끊겼어요. 같은 작업을 다시 실행하기 전에 결과를 확인해 주세요.',
              toolRecords,
              reasoning: '',
            }
          } else {
            logger.warn(
              'AI',
              `답장 스트리밍 실패(${
                error instanceof Error ? error.message : String(error)
              }) — generate 경로로 폴백`
            )
            result = {
              ...(await provider.generate(
                contextMessage,
                history,
                generateOptions
              )),
              reasoning: '',
              finishReason: undefined,
            }
          }
        }
      }
    }
    // 중단이면 승인 문구 복구를 건너뛴다. 그 경로는 provider를 다시 부를 수 있어
    // 버린 응답을 되살린다.
    const recovered = aborted
      ? result
      : await recoverFabricatedApproval(
          provider,
          contextMessage,
          history,
          generateOptions,
          result,
          input.approvalPending ?? (() => false)
        )
    result = {
      ...recovered,
      reasoning: result.reasoning,
      finishReason: result.finishReason,
    }

    const approvalPending = !aborted && (input.approvalPending?.() ?? false)
    const cleaned = approvalPending
      ? '요청하신 작업은 승인 대기 중이에요. 승인 카드가 표시되면 버튼으로 결정해 주세요.'
      : stripToolCallSyntax(stripThinkTags(result.text))

    const usedTools =
      !approvalPending && result.toolRecords.length > 0
        ? `\n\n> 사용: ${result.toolRecords.map((r) => r.name).join(', ')}`
        : ''
    // 중단이면 안내 문구만 보낸다. 대화가 이어진 게 아니므로 풋터 힌트를 붙이지
    // 않고, 사용자에게 "답을 끝까지 못 썼다"는 사실만 분명히 알린다.
    const response = aborted
      ? cleaned
      : cleaned.trim().length > 0
      ? `${cleaned}${usedTools}\n\n${FOOTER_HINT}`
      : describeEmptyResponse(result.finishReason)

    // 스트리밍 포트가 있으면 최종 확정 편집까지 마친 뒤 id를 받는다.
    // id가 있으면 이미 화면에 답이 있으므로 호출부는 reply()를 보내지 않는다.
    // 중단이어도 complete()는 반드시 부른다 — 렌더러의 편집 체인이 여기서
    // settle되지 않으면 thinking 메시지가 진행 상태로 남는다.
    const reasoningSummary = stream?.takeReasoningSummary() ?? ''
    const streamedMessageId =
      stream !== undefined
        ? await stream.complete(response, aborted)
        : undefined
    const visibleResponse =
      streamedMessageId !== undefined
        ? stream?.takeFinalText() ?? response
        : response
    const assistantText =
      visibleResponse === response ? cleaned : visibleResponse

    // 손상 판정은 원래 응답으로 한다. 렌더러가 반복을 잘라 화면에 남긴 앞부분은
    // 이미 정상처럼 보일 수 있으므로, 원문에서 반복 여부를 놓치지 않아야 한다.
    const damaged = classifyDamagedResponse({ text: cleaned, aborted })

    if (continued === undefined && previousBotResponse.trim().length > 0) {
      appendToSession(sessionKey, {
        content: previousBotResponse,
        role: 'assistant',
      })
    }
    appendToSession(
      sessionKey,
      {
        content: contextPrefix + userMessage,
        role: 'user',
        imageUrls: input.imageUrls,
        authorId: userId,
        sentAt: input.sentAt,
        replyToMessageId: referencedMessageId,
      },
      input.userMessageId
    )

    return {
      response: visibleResponse,
      assistantText,
      continuedFromSession: continued !== undefined,
      sessionKey,
      toolRecords: result.toolRecords,
      ...(damaged !== undefined ? { damaged } : {}),
      ...(aborted ? { aborted: true } : {}),
      ...(reasoningSummary.length > 0 ? { reasoningSummary } : {}),
      ...(streamedMessageId !== undefined ? { streamedMessageId } : {}),
    }
  } catch (error) {
    const interruption = abortedTurnFromSignal(error, input.abortSignal)
    const abortNotice = describeAbortedTurn(interruption)
    if (abortNotice !== undefined) {
      const reasoningSummary = stream?.takeReasoningSummary() ?? ''
      const streamedMessageId = await stream?.complete(abortNotice, true)
      appendToSession(
        sessionKey,
        {
          content: `[대화 중 - 사용자: ${
            input.memberDisplayName ?? '사용자'
          }] ${userMessage}`,
          role: 'user',
          imageUrls: input.imageUrls,
          authorId: userId,
          sentAt: input.sentAt,
          replyToMessageId: referencedMessageId,
        },
        input.userMessageId
      )
      return {
        response: abortNotice,
        assistantText: abortNotice,
        damaged: { kind: 'aborted' },
        aborted: true,
        continuedFromSession: continued !== undefined,
        sessionKey,
        toolRecords: toolRecordsFromError(interruption),
        ...(reasoningSummary.length > 0 ? { reasoningSummary } : {}),
        ...(streamedMessageId !== undefined ? { streamedMessageId } : {}),
      }
    }
    // 폴백 생성이나 프롬프트 구성도 실패할 수 있다. 진행 메시지를 오류 안내로
    // 확정해 버튼을 제거한다. 실패한 질문과 실패 마커도 함께 남겨 다음 턴의
    // 맥락이 질문 하나에서 끊기지 않도록 한다.
    logger.error(
      'AI',
      `답장 생성 실패: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    const reasoningSummary = stream?.takeReasoningSummary() ?? ''
    const streamedMessageId = await stream?.complete(REPLY_ERROR_NOTICE, true)
    appendToSession(
      sessionKey,
      {
        content: `[대화 중 - 사용자: ${
          input.memberDisplayName ?? '사용자'
        }] ${userMessage}`,
        role: 'user',
        imageUrls: input.imageUrls,
        authorId: userId,
        sentAt: input.sentAt,
        replyToMessageId: referencedMessageId,
      },
      input.userMessageId
    )
    return {
      response: REPLY_ERROR_NOTICE,
      assistantText: '',
      damaged: { kind: 'empty' },
      continuedFromSession: continued !== undefined,
      sessionKey,
      toolRecords: toolRecordsFromError(error),
      ...(reasoningSummary.length > 0 ? { reasoningSummary } : {}),
      ...(streamedMessageId !== undefined ? { streamedMessageId } : {}),
    }
  } finally {
    stream?.dispose()
  }
}

export function startSession(
  guildId: string,
  channelId: string,
  userId: string,
  userPrompt: string,
  botResponse: string
): string {
  const sessionKey = getOrCreateSession(guildId, channelId, userId)
  appendToSession(sessionKey, { content: userPrompt, role: 'user' })
  appendToSession(sessionKey, { content: botResponse, role: 'assistant' })
  return sessionKey
}
