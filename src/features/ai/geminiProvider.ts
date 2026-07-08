import type { ProviderAdapter } from './aiPolicy'
import { runGenerate } from './providerCore'
import { createGoogleGenerativeAI } from '@ai-sdk/google'

export type GeminiConfig = {
  readonly apiKey: string
  readonly model: string
}

export function createGeminiProvider(config: GeminiConfig): ProviderAdapter {
  if (config.apiKey.trim().length === 0) {
    throw new Error('Gemini API 키를 입력해 주세요.')
  }

  const google = createGoogleGenerativeAI({ apiKey: config.apiKey })
  const model = google(config.model)

  return {
    generate: async (prompt, history, options) =>
      runGenerate({
        model,
        modelName: config.model,
        label: 'Gemini',
        prompt,
        history,
        options,
      }),
  }
}
