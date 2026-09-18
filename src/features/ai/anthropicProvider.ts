import type { ProviderAdapter } from './aiPolicy'
import { runGenerate } from './providerCore'
import { createAnthropic } from '@ai-sdk/anthropic'

export type AnthropicConfig = {
  readonly apiKey: string
  readonly model: string
  // 컨텍스트 예산(토큰). 히스토리를 이 안에 맞춰 넣는다.
  readonly contextTokens?: number
}

export function createAnthropicProvider(
  config: AnthropicConfig
): ProviderAdapter {
  if (config.apiKey.trim().length === 0) {
    throw new Error('Anthropic API 키를 입력해 주세요.')
  }

  const anthropic = createAnthropic({ apiKey: config.apiKey })
  const model = anthropic(config.model)

  return {
    generate: async (prompt, history, options) =>
      runGenerate({
        model,
        modelName: config.model,
        label: 'Anthropic',
        prompt,
        history,
        options,
        contextTokens: config.contextTokens,
      }),
  }
}
