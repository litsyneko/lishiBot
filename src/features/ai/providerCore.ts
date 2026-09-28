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
import { ToolExecutionInterruptedError } from './providerErrors'
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
  tools?: readonly ToolDefinitionInput[]
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
      execute: t.execute,
    }
  }
  return toolsParam as ToolSet
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
      success: matching !== undefined,
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
 * generateText와 streamText가 반드시 공유해야 하는 요청 구성.
 * 시스템 프롬프트·히스토리 예산 절단·도구 빌드·sampling·reasoningEffort·
 * maxRetries를 한 군데서 만들어 두 경로가 갈라지는 일 자체를 막는다.
 */
type CoreRequest = {
  readonly system: string
  readonly messages: ModelMessage[]
  readonly tools: ToolSet | undefined
  readonly temperature: number | undefined
  readonly providerOptions: Record<string, Record<string, string>> | undefined
  readonly maxRetries: number
  readonly stopWhen: StopCondition<ToolSet>
  readonly onStepEnd: (step: StepLike) => void
}

function resolveCoreRequest(
  input: RunGenerateInput,
  onStepEnd: (step: StepLike) => void
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
    tools: buildToolsParam(input.options?.tools),
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
    }
  )

  let result
  try {
    result = await generateText({ model, ...request })
  } catch (error) {
    if (observedToolRecords.length > 0) {
      throw new ToolExecutionInterruptedError(error, observedToolRecords)
    }
    throw error
  }

  const text = result.text ?? ''
  const toolRecords =
    observedToolRecords.length > 0
      ? observedToolRecords
      : (result.steps ?? []).flatMap((step) => extractToolRecords(step))

  try {
    assertOutputSafe(text)
  } catch (error) {
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
  const observedToolRecords: ToolRecord[] = []
  const request = resolveCoreRequest(input, (step) => {
    const records = extractToolRecords(step)
    observedToolRecords.push(...records)
    logger.info(
      'AI',
      `${input.label} step=${step.stepNumber} finish=${step.finishReason} tools=${records.length}`
    )
  })

  const result = streamText({ model: input.model, ...request })

  // 스트리밍이 실제로 사용자에게 노출됐는지. 노출 전 실패만 generate로
  // 조용히 강등할 수 있다(노출 후에는 체인 폴백이 정답이다).
  let isExposed = false
  let isToolUsed = false
  let streamError: unknown

  try {
    for await (const part of result.stream) {
      if (part.type === 'reasoning-delta') {
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
    streamError = iterationError
  }

  // 스트리밍 미지원이 명확할 때만 generate로 강등한다. 할당량 부족·인증
  // 실패·HTTP 오류는 같은 요청을 반복해도 해결되지 않으므로 체인으로 넘긴다.
  if (
    streamError !== undefined &&
    !isExposed &&
    !isToolUsed &&
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
    if (isToolUsed || observedToolRecords.length > 0) {
      throw new ToolExecutionInterruptedError(streamError, observedToolRecords)
    }
    throw streamError
  }

  let text: string
  try {
    text = await result.text
    // 전체가 다 나온 뒤에야 가드를 건다.
    assertOutputSafe(text)
  } catch (error) {
    if (isToolUsed || observedToolRecords.length > 0) {
      throw new ToolExecutionInterruptedError(error, observedToolRecords)
    }
    throw error
  }

  const toolRecords =
    observedToolRecords.length > 0
      ? observedToolRecords
      : (await result.steps).flatMap((step) => extractToolRecords(step))

  const finalStep = await result.finalStep
  const reasoning = finalStep.reasoningText ?? ''

  logger.info(
    'AI',
    `${input.label} 스트리밍 응답 (본문 ${text.length}자, 사고 ${reasoning.length}자, ` +
      `${toolRecords.length}개 툴 실행, finish=${finalStep.finishReason})`
  )

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
