import { logger } from '../../utils/logger'
import type {
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  ToolDefinitionInput,
  ToolRecord,
} from './aiPolicy'
import { assertOutputSafe } from './outputGuard'
import { KOREAN_SYSTEM_PROMPT } from './systemPrompt'
import { type LanguageModel, type ToolSet, generateText, stepCountIs } from 'ai'
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
  const messages: Array<{ content: string; role: 'user' | 'assistant' }> = []

  if (history !== undefined) {
    for (const msg of history) {
      messages.push({ content: msg.content, role: msg.role })
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
): Record<string, unknown> | undefined {
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
  return toolsParam
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
  systemPrompt: string,
  contextTokens: number
): readonly ChatMessage[] {
  const budget = Math.floor(contextTokens * 0.7) - estimateTokens(systemPrompt)
  if (budget <= 0) return []

  let used = 0
  let start = history.length
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens(history[i].content)
    if (used + cost > budget) break
    used += cost
    start = i
  }
  return history.slice(start)
}

export async function runGenerate({
  model,
  modelName,
  label,
  prompt,
  history,
  options,
  reasoningEffort,
  contextTokens,
}: RunGenerateInput): Promise<GenerateResult> {
  const systemPrompt = options?.systemPrompt ?? KOREAN_SYSTEM_PROMPT
  const maxSteps = options?.maxSteps ?? 20
  const toolsParam = buildToolsParam(options?.tools)
  const toolNames = options?.tools?.map((t) => t.name).join(', ') ?? 'none'
  const observedToolRecords: ToolRecord[] = []

  const selectedHistory =
    contextTokens === undefined
      ? history ?? []
      : selectHistoryWithinBudget(history ?? [], systemPrompt, contextTokens)

  logger.info(
    'AI',
    `${label} 요청: model=${modelName} tools=[${toolNames}] maxSteps=${maxSteps}${
      reasoningEffort !== undefined ? ` reasoningEffort=${reasoningEffort}` : ''
    }${
      contextTokens !== undefined
        ? ` ctx=${contextTokens} history=${selectedHistory.length}/${
            history?.length ?? 0
          }`
        : ''
    }`
  )

  const result = await generateText({
    model,
    system: systemPrompt,
    messages: toModelMessages(prompt, selectedHistory),
    tools: toolsParam as ToolSet | undefined,
    // reasoning_effort 본문 파라미터로 변환되는 SDK 표준 옵션. provider 이름
    // ('opencode-zen') 아래로도 읽히지만, 최상위 표준 키가 경고가 없어 안전하다.
    providerOptions:
      reasoningEffort !== undefined
        ? { openaiCompatible: { reasoningEffort } }
        : undefined,
    // 재시도는 resilientFetch(HTTP 요청 단위)가 전담한다. SDK 기본값(2회)을
    // 살려두면 fetch 재시도와 곱해져 시도 횟수가 배가되므로 여기서 끈다.
    maxRetries: 0,
    stopWhen: stepCountIs(maxSteps),
    onStepEnd: (step) => {
      const records = extractToolRecords(step)
      observedToolRecords.push(...records)
      logger.info(
        'AI',
        `${label} step=${step.stepNumber} finish=${step.finishReason} tools=${records.length}`
      )
    },
  })

  const text = result.text ?? ''

  // reject rather than strip — partially-corrupted output must activate provider-chain fallback
  assertOutputSafe(text)

  const toolRecords =
    observedToolRecords.length > 0
      ? observedToolRecords
      : (result.steps ?? []).flatMap((step) => extractToolRecords(step))

  logger.info(
    'AI',
    `${label} 응답 (${text.length}자, ${toolRecords.length}개 툴 실행)`
  )

  return { text, toolRecords }
}
