import type { ProviderAdapter } from './aiPolicy'
import { runGenerate } from './providerCore'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

export type OpencodeZenConfig = {
  readonly apiKey: string
  readonly model: string
}

const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

export function createOpencodeZenProvider(
  config: OpencodeZenConfig
): ProviderAdapter {
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
    generate: async (prompt, history, options) =>
      runGenerate({
        model,
        modelName: config.model,
        label: 'OpenCode Zen',
        prompt,
        history,
        options,
      }),
  }
}
