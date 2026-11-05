import { logger } from '../../utils/logger'
import type {
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  StreamHandlers,
  StreamResult,
  ToolDefinitionInput,
  ToolRecord,
} from './aiPolicy'
import { assertOutputSafe } from './outputGuard'
import {
  type AiTurnAbortReason,
  AiTurnAbortedError,
  ToolExecutionInterruptedError,
} from './providerErrors'
import { KOREAN_SYSTEM_PROMPT } from './systemPrompt'
import {
  type LanguageModel,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
  generateText,
  stepCountIs,
  streamText,
} from 'ai'
import { z } from 'zod'

type RunGenerateInput = {
  readonly model: LanguageModel
  readonly modelName: string
  readonly label: string
  readonly prompt: string
  readonly history?: readonly ChatMessage[]
  readonly options?: GenerateOptions
  // 생각(추론) 노력. 미지정 시 엔드포인트 기본값을 따른다.
  readonly reasoningEffort?: string
  // 생성 온도. 미지정 시 SDK/엔드포인트 기본값을 그대로 둔다.
  readonly temperature?: number
  // 컨텍스트 예산(토큰). 시스템 프롬프트·히스토리·응답이 이 안에 들어가도록
  // 히스토리를 최신 우선으로 잘라 넣는다. 미지정 시 히스토리를 전부 포함.
  readonly contextTokens?: number
}

type ToolCallLike = {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
}

type ToolResultLike = {
  readonly toolCallId: string
  readonly output?: unknown
}

type StepLike = {
  readonly stepNumber?: number
  readonly finishReason?: unknown
  readonly toolCalls?: readonly ToolCallLike[]
  readonly toolResults?: readonly ToolResultLike[]
}

function toModelMessages(prompt: string, history?: readonly ChatMessage[]) {
  const messages: ModelMessage[] = []

  if (history !== undefined) {
    for (const msg of history) {
      if (msg.role === 'user' && msg.imageUrls?.length) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: msg.content },
            ...msg.imageUrls.map((url) => ({
              type: 'image' as const,
              image: new URL(url),
            })),
          ],
        })
      } else {
        messages.push({ content: msg.content, role: msg.role })
      }
    }
  }

  messages.push({ content: prompt, role: 'user' })
  return messages
}

function buildZodSchema(
  properties: ToolDefinitionInput['parameters']['properties'],
  required: readonly string[]
) {
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const [key, prop] of Object.entries(properties)) {
    let schema: z.ZodTypeAny

    if (prop.type === 'string') {
      schema = z.string()
    } else if (prop.type === 'integer' || prop.type === 'number') {
      schema = z.number()
    } else if (prop.type === 'boolean') {
      schema = z.boolean()
    } else if (prop.type === 'array') {
      schema = z.array(z.any())
    } else {
      schema = z.any()
    }

    schema = schema.describe(prop.description)

    if (prop.enum !== undefined) {
      schema = z
        .enum(prop.enum as [string, ...string[]])
        .describe(prop.description)
    }

    if (!required.includes(key)) {
      schema = schema.optional()
    }

    shape[key] = schema
  }

  return z.object(shape)
}

function buildToolsParam(
  tools?: readonly ToolDefinitionInput[],
  attempted?: ToolRecord[]
): ToolSet | undefined {
  if (tools === undefined || tools.length === 0) {
    return undefined
  }

  const toolsParam: Record<string, unknown> = {}
  for (const t of tools) {
    toolsParam[t.name] = {
      description: t.description,
      inputSchema: buildZodSchema(
        t.parameters.properties,
        t.parameters.required
      ),
      execute: async (args: Record<string, unknown>) => {
        const record: ToolRecord = {
          name: t.name,
          args,
          result: '도구 실행 결과를 확인할 수 없어요.',
          success: false,
        }
        attempted?.push(record)
        try {
          const result = await t.execute(args)
          if (attempted) {
            attempted[attempted.indexOf(record)] = {
              ...record,
              result,
              success: toolResultSucceeded(result),
            }
          }
          return result
        } catch (error) {
          if (attempted) {
            attempted[attempted.indexOf(record)] = {
              ...record,
              result: error instanceof Error ? error.message : String(error),
            }
          }
          throw error
        }
      },
    }
  }
  return toolsParam as ToolSet
}

function toolResultSucceeded(result: unknown): boolean {
  return !(
    typeof result === 'object' &&
    result !== null &&
    'success' in result &&
    result.success === false
  )
}

function extractToolRecords(step: StepLike): ToolRecord[] {
  const calls = step.toolCalls ?? []
  const results = step.toolResults ?? []
  return calls.map((call) => {
    const matching = results.find((r) => r.toolCallId === call.toolCallId)
    return {
      name: call.toolName,
      args: call.input as Record<string, unknown>,
      result: matching?.output,
      success: matching !== undefined && toolResultSucceeded(matching.output),
    }
  })
}

// 정확한 토크나이저가 없어 글자 수 기반 추정치를 쓴다. 한국어 중심 대화 기준
// 다소 과소추정이므로, 예산의 30%는 응답·도구 호출·오차 여유로 남겨둔다.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.5) + 8
}

/** 예산 안에 들어가는 가장 긴 최신 히스토리 접미사를 고른다. */
function selectHistoryWithinBudget(
  history: readonly ChatMessage[],
  reservedTokens: number,
  contextTokens: number
): readonly ChatMessage[] {
  const budget = Math.floor(contextTokens * 0.7) - reservedTokens
  if (budget <= 0) return []

  let used = 0
  let start = history.length
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const cost =
      estimateTokens(history[i].content) +
      (history[i].imageUrls?.length ?? 0) * 1500
    if (used + cost > budget) break
    used += cost
    start = i
  }
  return history.slice(start)
}

/**
 * 신호에서 중단 사유를 읽는다. 호출부(중지 버튼·데드라인)는
 * controller.abort(new AiTurnAbortedError(reason))로 사유를 실어 올린다.
 * 사유를 모르면 undefined를 돌려준다.
 */
function abortReasonFromSignal(
  signal: AbortSignal | undefined
): AiTurnAbortReason | undefined {
  const reason: unknown = signal?.reason
  return reason instanceof AiTurnAbortedError ? reason.reason : undefined
}

/**
 * 오류를 '중단'으로 해석해 줄 AiTurnAbortedError를 만든다. 중단이 아니면
 * undefined를 돌려준다(호출부는 undefined면 원래 오류 경로를 그대로 탄다).
 *
 * 판정 근거는 두 가지다.
 * 1. SDK가 fetch 중단을 표준 신호인 AbortError로 흘려보낸다.
 * 2. 신호가 이미 올라온 상태면 남은 오류는 무엇이든 중단의 후유증이다.
 *    (중단과 동시에 터진 네트워크 오류를 'provider 실패'로 오인하면 폴백 체인이
 *    달려가 버린 응답을 다시 생성해 버린다.)
 *
 * 사유는 신호에서 읽는다. 신호를 올린 쪽이 사유를 알기 때문에(중지 버튼은
 * user-stop, 데드라인은 deadline) 여기서 전부 'external'로 뭉개면 사용자는
 * 자기 클릭과 시간 초과를 구분할 수 없다. 신호가 사유를 담지 않은 경우에만
 * 'external'로 본다.
 */
function toAbortedTurnError(
  error: unknown,
  signal: AbortSignal | undefined,
  toolRecords: readonly ToolRecord[] = []
): AiTurnAbortedError | undefined {
  if (error instanceof AiTurnAbortedError) {
    return toolRecords.length > 0 && error.toolRecords.length === 0
      ? new AiTurnAbortedError(error.reason, toolRecords)
      : error
  }
  const isAborted =
    (error instanceof Error && error.name === 'AbortError') ||
    signal?.aborted === true
  if (!isAborted) {
    return undefined
  }
  return new AiTurnAbortedError(
    abortReasonFromSignal(signal) ?? 'external',
    toolRecords
  )
}

/**
 * generateText와 streamText가 반드시 공유해야 하는 요청 구성.
 * 시스템 프롬프트·히스토리 예산 절단·도구 빌드·sampling·reasoningEffort·
 * maxRetries를 한 군데서 만들어 두 경로가 갈라지는 일 자체를 막는다.
 */
type CoreRequest = {
  readonly system: string
  readonly messages: ModelMessage[]
  readonly tools: ToolSet | undefined
  readonly toolChoice?:
    | 'auto'
    | 'required'
    | { readonly type: 'tool'; readonly toolName: string }
  readonly temperature: number | undefined
  readonly providerOptions: Record<string, Record<string, string>> | undefined
  readonly maxRetries: number
  readonly stopWhen: StopCondition<ToolSet>
  readonly onStepEnd: (step: StepLike) => void
  // 중단 신호를 그대로 SDK로 넘긴다. 변환·생성 로직을 두지 않는 이유는
  // 신호의 의미를 이 계층에서 바꾸면 폴백/강등 판정이 전부 어긋나기 때문이다.
  readonly abortSignal: AbortSignal | undefined
}

function resolveCoreRequest(
  input: RunGenerateInput,
  onStepEnd: (step: StepLike) => void,
  attempted: ToolRecord[]
): CoreRequest {
  const systemPrompt = input.options?.systemPrompt ?? KOREAN_SYSTEM_PROMPT
  const maxSteps = input.options?.maxSteps ?? 20

  const toolCost =
    input.options?.tools?.reduce(
      (total, tool) =>
        total +
        estimateTokens(
          JSON.stringify({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })
        ),
      0
    ) ?? 0
  const reservedTokens =
    estimateTokens(systemPrompt) +
    estimateTokens(input.prompt) +
    toolCost +
    (input.options?.imageUrls?.length ?? 0) * 1500
  const selectedHistory =
    input.contextTokens === undefined
      ? input.history ?? []
      : selectHistoryWithinBudget(
          input.history ?? [],
          reservedTokens,
          input.contextTokens
        )

  const toolNames =
    input.options?.tools?.map((t) => t.name).join(', ') ?? 'none'

  logger.info(
    'AI',
    `${input.label} 요청: model=${
      input.modelName
    } tools=[${toolNames}] maxSteps=${maxSteps}${
      input.reasoningEffort !== undefined
        ? ` reasoningEffort=${input.reasoningEffort}`
        : ''
    }${
      input.temperature !== undefined ? ` temperature=${input.temperature}` : ''
    }${
      input.contextTokens !== undefined
        ? ` ctx=${input.contextTokens} history=${selectedHistory.length}/${
            input.history?.length ?? 0
          }`
        : ''
    }`
  )

  const messages = toModelMessages(input.prompt, selectedHistory)
  if (input.options?.imageUrls?.length) {
    messages[messages.length - 1] = {
      role: 'user',
      content: [
        { type: 'text', text: input.prompt },
        ...input.options.imageUrls.map((url) => ({
          type: 'image' as const,
          image: new URL(url),
        })),
      ],
    }
  }

  return {
    system: systemPrompt,
    messages,
    tools: buildToolsParam(input.options?.tools, attempted),
    toolChoice: input.options?.toolChoice,
    // 표준 sampling 파라미터. OpenAI-호환 엔드포인트(Ollama 포함)는 본문
    // temperature로 그대로 받으며, undefined면 본문에서 아예 빠진다.
    temperature: input.temperature,
    // reasoning_effort 본문 파라미터로 변환되는 SDK 표준 옵션. provider 이름
    // ('opencode-zen') 아래로도 읽히지만, 최상위 표준 키가 경고가 없어 안전하다.
    providerOptions:
      input.reasoningEffort !== undefined
        ? { openaiCompatible: { reasoningEffort: input.reasoningEffort } }
        : undefined,
    // 재시도는 resilientFetch(HTTP 요청 단위)가 전담한다. SDK 기본값(2회)을
    // 살려두면 fetch 재시도와 곱해져 시도 횟수가 배가되므로 여기서 끈다.
    maxRetries: 0,
    stopWhen: stepCountIs(maxSteps),
    onStepEnd,
    abortSignal: input.options?.abortSignal,
  }
}

export async function runGenerate({
  model,
  modelName,
  label,
  prompt,
  history,
  options,
  reasoningEffort,
  temperature,
  contextTokens,
}: RunGenerateInput): Promise<GenerateResult> {
  const observedToolRecords: ToolRecord[] = []
  const attemptedToolRecords: ToolRecord[] = []
  const request = resolveCoreRequest(
    {
      model,
      modelName,
      label,
      prompt,
      history,
      options,
      reasoningEffort,
      temperature,
      contextTokens,
    },
    (step) => {
      const records = extractToolRecords(step)
      observedToolRecords.push(...records)
      logger.info(
        'AI',
        `${label} step=${step.stepNumber} finish=${step.finishReason} tools=${records.length}`
      )
    },
    attemptedToolRecords
  )

  let result
  try {
    result = await generateText({ model, ...request })
  } catch (error) {
    // 중단이 ToolExecutionInterruptedError보다 우선이다. 도구가 이미 실행된
    // 상태라 해도 '중단'은 실패가 아니라 사용자 의도이므로, 재실행 금지
    // 안내로 바꾸지 않고 그대로 위로 올린다.
    const aborted = toAbortedTurnError(
      error,
      options?.abortSignal,
      attemptedToolRecords.length > 0
        ? attemptedToolRecords
        : observedToolRecords
    )
    if (aborted !== undefined) {
      throw aborted
    }
    if (attemptedToolRecords.length > 0 || observedToolRecords.length > 0) {
      throw new ToolExecutionInterruptedError(
        error,
        attemptedToolRecords.length > 0
          ? attemptedToolRecords
          : observedToolRecords
      )
    }
    throw error
  }

  const text = result.text ?? ''
  const toolRecords =
    attemptedToolRecords.length > 0
      ? attemptedToolRecords
      : observedToolRecords.length > 0
      ? observedToolRecords
      : (result.steps ?? []).flatMap((step) => extractToolRecords(step))

  try {
    assertOutputSafe(text)
  } catch (error) {
    const aborted = toAbortedTurnError(error, options?.abortSignal, toolRecords)
    if (aborted !== undefined) {
      throw aborted
    }
    if (toolRecords.length > 0) {
      throw new ToolExecutionInterruptedError(error, toolRecords)
    }
    throw error
  }

  logger.info(
    'AI',
    `${label} 응답 (${text.length}자, ${toolRecords.length}개 툴 실행)`
  )

  return { text, toolRecords }
}

/** 스트리밍 기능 자체를 지원하지 않을 때만 비스트리밍으로 재시도한다. */
function isStreamingUnsupported(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const status = (error as Error & { statusCode?: number }).statusCode
  if (
    status !== undefined &&
    status !== 400 &&
    status !== 422 &&
    status !== 501
  ) {
    return false
  }
  return (
    /stream(?:ing)?|스트리밍/iu.test(error.message) &&
    /unsupported|not supported|not implemented|미지원|지원하지/iu.test(
      error.message
    )
  )
}

/** 스트리밍을 다 소모한 뒤 남아 있는 결과의 관측값. */
type EmptyStreamOutcome = {
  readonly textChars: number
  readonly toolCount: number
  readonly reasoningChars: number
  readonly reasoningDeltaChars: number
  readonly finishReason: unknown
  readonly elapsedMs: number
}

/**
 * "정상으로 끝났는데 답이 없다" 상태를 골라 운영 경고 문구를 만든다.
 * 경고할 상태가 아니면 undefined를 돌려준다(정상 경로에 경고를 찍지 않기 위함).
 *
 * 왜 이렇게 분류하는가.
 *
 * A. 완전 무응답(본문 0 + 사고 0 + 도구 0)
 *    provider가 200 응답 헤더만 주고 SSE 바디를 하나도 안 보낸 상태다.
 *    resilientFetch의 withTimeout은 HTTP 헤더를 받는 순간 타이머가 시작하므로
 *    헤더 뒤의 침묵은 타임아웃으로 잡히지 않는다. 더 나쁜 것은 SDK가 이걸
 *    '정상 종료 + 빈 내용'으로 정리해 thrown 에러조차 남기지 않는다는 점이다.
 *    그러니 여기서 조용히 넘어가면 다음 장애 때 pm2에 남는 건
 *    '턴 첫 활동 45000ms 초과(응답 없음)'뿐이라 provider 무응답인지,
 *    SDK 스트림 소비기 문제인지, 모델이 빈 문자열을 준 건지 구분할 수 없고
 *    5분 안에 원인을 못 좁힌다. 원인 후보가 가장 많으므로 가장 중요하다.
 *
 * B. 사고만 있고 답 없음(본문 0 + 사고 > 0 + 도구 0)
 *    사고가 토큰 예산을 다 쓴 경우(종료사유 'length')로 자주 관측된다.
 *    위 describeEmptyResponse도 'length'를 '토큰 예산 소진'으로 다루므로,
 *    운영자가 같은 신호를 두 벌로 해석하지 않도록 finishReason을 반드시 싣는다.
 *
 * C. 도구 사용 후 본문 없음(본문 0 + 도구 > 0)은 경고하지 않는다.
 *    도구가 끼어든 오류 경로는 위쪽에서 ToolExecutionInterruptedError로
 *    갈라져 나가고, 도구 실행 개수는 info 로그에 이미 남는다. 한 장애를
 *    경고 두 번 찍으면 운영 로그의 신호 대 잡음 비율이 오히려 커진다.
 */
function describeEmptyStreamOutcome(
  input: RunGenerateInput,
  outcome: EmptyStreamOutcome
): string | undefined {
  // 판정 근거: 경고는 "본문이 하나도 없고 도구로 도출된 것도 없을 때"만 건다.
  // 이 조건을 느슨하게 잡으면 정상 응답이 경고로 새고, 이미 경고가 많은 이
  // 저장소의 운영 로그에서 진짜 문제가 묻힌다. 따라서 둘 중 하나라도 있으면
  // 여기서 즉시 빠져나간다.
  const isNormalPath = outcome.textChars > 0 || outcome.toolCount > 0
  if (isNormalPath) return undefined

  const context = `provider=${input.label} model=${input.modelName} 소요=${outcome.elapsedMs}ms`

  if (outcome.reasoningChars > 0) {
    return (
      `${input.label} 스트리밍 답 없음 — 사고만 수신(${context}, ` +
      `사고 ${outcome.reasoningChars}자, 사고 스트리밍 ${outcome.reasoningDeltaChars}자, ` +
      `finish=${outcome.finishReason})`
    )
  }

  return (
    `${input.label} 스트리밍 완전 무응답(${context}, 본문 0자, 사고 0자, ` +
    `사고 스트리밍 ${outcome.reasoningDeltaChars}자, finish=${outcome.finishReason}) — ` +
    `SSE 바디를 하나도 못 받음`
  )
}

/**
 * 스트리밍 경로. runGenerate와 동일한 CoreRequest를 재사용하므로 프롬프트·
 * 도구·sampling이 갈라지지 않는다.
 *
 * 스트리밍 도중에는 출력이 덜 나왔으므로 assertOutputSafe를 걸 수 없다.
 * 전체가 모인 **완료 후** 최종 text에 같은 가드를 적용해, 손상 출력은 기존과
 * 같이 폴백 체인을 발동시킨다.
 */
export async function runStream(
  input: RunGenerateInput,
  handlers: StreamHandlers
): Promise<StreamResult> {
  // 스트림 소요 시간 기준점. 아래 빈 결과 진단 경고 전용이다. 헤더만 받고
  // 바디가 없는 provider(Ollama 무응답)는 다른 계층에 남는 단서가 이것뿐이라
  // 무관한 곳(요청 헤더 등)에 흘려 보내지 않고 진단 경로에서만 쓴다.
  const streamStartedAt = Date.now()
  const observedToolRecords: ToolRecord[] = []
  const attemptedToolRecords: ToolRecord[] = []
  const request = resolveCoreRequest(
    input,
    (step) => {
      const records = extractToolRecords(step)
      observedToolRecords.push(...records)
      logger.info(
        'AI',
        `${input.label} step=${step.stepNumber} finish=${step.finishReason} tools=${records.length}`
      )
    },
    attemptedToolRecords
  )

  const result = streamText({ model: input.model, ...request })

  // 스트리밍이 실제로 사용자에게 노출됐는지. 노출 전 실패만 generate로
  // 조용히 강등할 수 있다(노출 후에는 체인 폴백이 정답이다).
  let isExposed = false
  let isToolUsed = false
  let reasoningDeltaChars = 0
  let streamError: unknown

  try {
    for await (const part of result.stream) {
      if (part.type === 'reasoning-delta') {
        reasoningDeltaChars += part.text.length
        isExposed = true
        handlers.onReasoning?.(part.text)
      } else if (part.type === 'text-delta') {
        isExposed = true
        handlers.onText?.(part.text)
      } else if (part.type === 'tool-call') {
        isToolUsed = true
        handlers.onToolCall?.(part.toolName)
      } else if (part.type === 'error') {
        // error part는 스트림을 멈추지 않는다. 원인을 기억해 사후에 처리한다.
        streamError = part.error
      }
    }
  } catch (iterationError) {
    // 중단 판정이 강등 분기보다 먼저야 한다. 중단된 요청을 generate로 다시
    // 실행하면 사용자가 버린 응답이 그대로 재생성된다(토큰 낭비 + 화면에
    // 두 번 노출). error로 축약해 두면 아래 강등 로직이 그걸 못 구분한다.
    const aborted = toAbortedTurnError(
      iterationError,
      input.options?.abortSignal,
      attemptedToolRecords.length > 0
        ? attemptedToolRecords
        : observedToolRecords
    )
    if (aborted !== undefined) {
      throw aborted
    }
    streamError = iterationError
  }

  // 스트림을 throw하지 않고 error part로 알려주는 provider가 있다. 중단도
  // 같은 규칙을 따라 여기서 한 번 더 판정한다.
  if (streamError !== undefined) {
    const aborted = toAbortedTurnError(
      streamError,
      input.options?.abortSignal,
      attemptedToolRecords.length > 0
        ? attemptedToolRecords
        : observedToolRecords
    )
    if (aborted !== undefined) {
      throw aborted
    }
  }

  // 스트리밍 미지원이 명확할 때만 generate로 강등한다. 할당량 부족·인증
  // 실패·HTTP 오류는 같은 요청을 반복해도 해결되지 않으므로 체인으로 넘긴다.
  // 중단은 위에서 걸러냈으므로 여기까지 온 오류는 provider가 스트리밍을 못
  // 한다는 뜻일 때뿐이다.
  if (
    streamError !== undefined &&
    !isExposed &&
    !isToolUsed &&
    attemptedToolRecords.length === 0 &&
    observedToolRecords.length === 0 &&
    isStreamingUnsupported(streamError)
  ) {
    logger.warn(
      'AI',
      `${input.label} 스트리밍 실패(${describeError(
        streamError
      )}) — generate로 강등`
    )
    const degraded = await runGenerate(input)
    return { ...degraded, reasoning: '', finishReason: undefined }
  }

  if (streamError !== undefined) {
    if (
      isToolUsed ||
      attemptedToolRecords.length > 0 ||
      observedToolRecords.length > 0
    ) {
      throw new ToolExecutionInterruptedError(
        streamError,
        attemptedToolRecords.length > 0
          ? attemptedToolRecords
          : observedToolRecords
      )
    }
    throw streamError
  }

  let text: string
  let toolRecords: ToolRecord[] = []
  let finalStep: Awaited<typeof result.finalStep>
  try {
    text = await result.text
    // 전체가 다 나온 뒤에야 가드를 건다.
    assertOutputSafe(text)
    toolRecords =
      attemptedToolRecords.length > 0
        ? attemptedToolRecords
        : observedToolRecords.length > 0
        ? observedToolRecords
        : (await result.steps).flatMap((step) => extractToolRecords(step))
    finalStep = await result.finalStep
  } catch (error) {
    // text, steps, finalStep 취합 중 어느 지점에서 실패해도 실행한 도구가
    // 있으면 턴 전체를 다시 재생하지 않는다.
    const records =
      attemptedToolRecords.length > 0
        ? attemptedToolRecords
        : observedToolRecords.length > 0
        ? observedToolRecords
        : toolRecords
    const aborted = toAbortedTurnError(
      error,
      input.options?.abortSignal,
      records
    )
    if (aborted !== undefined) {
      throw aborted
    }
    if (isToolUsed || records.length > 0) {
      throw new ToolExecutionInterruptedError(error, records)
    }
    throw error
  }
  const reasoning = finalStep.reasoningText ?? ''

  logger.info(
    'AI',
    `${input.label} 스트리밍 응답 (본문 ${text.length}자, 사고 ${reasoning.length}자, ` +
      `${toolRecords.length}개 툴 실행, 사고 스트리밍 ${reasoningDeltaChars}자, finish=${finalStep.finishReason})`
  )

  // "정상 종료 + 빈 내용"은 위 로그 한 줄로는 정상 응답과 구분되지 않는다.
  // 결과가 비었을 때만 따로 분류해 경고로 남겨야 다음 장애의 원인을 좁힐 수 있다.
  const emptyStreamWarning = describeEmptyStreamOutcome(input, {
    textChars: text.length,
    toolCount: toolRecords.length,
    reasoningChars: reasoning.length,
    reasoningDeltaChars,
    finishReason: finalStep.finishReason,
    elapsedMs: Date.now() - streamStartedAt,
  })
  if (emptyStreamWarning !== undefined) {
    logger.warn('AI', emptyStreamWarning)
  }

  return {
    text,
    toolRecords,
    reasoning,
    finishReason: finalStep.finishReason,
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
