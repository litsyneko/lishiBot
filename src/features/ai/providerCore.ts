import { logger } from '../../utils/logger'
import type {
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  ToolDefinitionInput,
  ToolRecord,
} from './aiPolicy'
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

export async function runGenerate({
  model,
  modelName,
  label,
  prompt,
  history,
  options,
}: RunGenerateInput): Promise<GenerateResult> {
  const systemPrompt = options?.systemPrompt ?? KOREAN_SYSTEM_PROMPT
  const maxSteps = options?.maxSteps ?? 20
  const toolsParam = buildToolsParam(options?.tools)
  const toolNames = options?.tools?.map((t) => t.name).join(', ') ?? 'none'
  const observedToolRecords: ToolRecord[] = []

  logger.info(
    'AI',
    `${label} 요청: model=${modelName} tools=[${toolNames}] maxSteps=${maxSteps}`
  )

  const result = await generateText({
    model,
    system: systemPrompt,
    messages: toModelMessages(prompt, history),
    tools: toolsParam as ToolSet | undefined,
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
