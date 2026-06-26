import { generateText, stepCountIs } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'
import type { ChatMessage, ProviderAdapter, ToolDefinitionInput } from './aiPolicy'
import { KOREAN_SYSTEM_PROMPT } from './systemPrompt'
import { logger } from '../../utils/logger'

export type OpencodeZenConfig = {
  readonly apiKey: string
  readonly model: string
}

const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

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

function buildZodSchema(properties: Record<string, { type: string; description: string; enum?: readonly string[] }>, required: readonly string[]) {
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const [key, prop] of Object.entries(properties)) {
    let schema: z.ZodTypeAny

    if (prop.type === 'string') {
      schema = z.string()
    } else if (prop.type === 'integer' || prop.type === 'number') {
      schema = z.number()
    } else if (prop.type === 'boolean') {
      schema = z.boolean()
    } else {
      schema = z.any()
    }

    schema = schema.describe(prop.description)

    if (prop.enum !== undefined) {
      schema = z.enum(prop.enum as [string, ...string[]]).describe(prop.description)
    }

    if (!required.includes(key)) {
      schema = schema.optional()
    }

    shape[key] = schema
  }

  return z.object(shape)
}

export function createOpencodeZenProvider(config: OpencodeZenConfig): ProviderAdapter {
  if (config.apiKey.trim().length === 0) {
    throw new Error('OpenCode Zen API 키를 입력해 주세요.')
  }

  const provider = createOpenAICompatible({
    name: 'opencode-zen',
    baseURL: OPENCODE_ZEN_BASE_URL,
    apiKey: config.apiKey,
  })
  const model = provider(config.model)

  return {
    generate: async (prompt, history, options) => {
      const systemPrompt = options?.systemPrompt ?? KOREAN_SYSTEM_PROMPT
      const maxSteps = options?.maxSteps ?? 20

      let toolsParam: Record<string, unknown> | undefined
      if (options?.tools !== undefined && options.tools.length > 0) {
        toolsParam = {}
        for (const t of options.tools) {
          toolsParam[t.name] = {
            description: t.description,
            inputSchema: buildZodSchema(t.parameters.properties, t.parameters.required),
            execute: t.execute,
          }
        }
      }

      const toolNames = options?.tools?.map((t) => t.name).join(', ') ?? 'none'
      logger.info('AI', `OpenCode Zen 요청: model=${config.model} tools=[${toolNames}] maxSteps=${maxSteps}`)

      const result = await generateText({
        model,
        system: systemPrompt,
        messages: toModelMessages(prompt, history),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: toolsParam as any,
        stopWhen: stepCountIs(maxSteps),
      })

      const text = result.text ?? ''
      const toolRecords = (result.steps ?? []).flatMap((step) => {
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
      })

      logger.info('AI', `OpenCode Zen 응답 (${text.length}자, ${toolRecords.length}개 툴 실행)`)

      return { text, toolRecords }
    },
  }
}

