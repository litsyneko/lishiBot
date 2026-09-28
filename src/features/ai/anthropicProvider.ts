import type { ProviderAdapter } from './aiPolicy'
import { runGenerate, runStream } from './providerCore'
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
    label: 'Anthropic',
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
    // 스트리밍 미지원 환경에서의 안전망은 runStream 내부에 있다 — 노출된
    // 토큰이 없으면 generate로 조용히 강등된다.
    stream: async (prompt, history, options, handlers) =>
      runStream(
        {
          model,
          modelName: config.model,
          label: 'Anthropic',
          prompt,
          history,
          options,
          contextTokens: config.contextTokens,
        },
        handlers
      ),
  }
}
