import type { GenerateResult, ProviderAdapter } from './aiPolicy'

export type AiProviderChainConfig = {
  readonly fallback?: ProviderAdapter | undefined
  readonly primary: ProviderAdapter
}

export function createAiProviderChain(
  config: AiProviderChainConfig
): ProviderAdapter {
  return {
    generate: async (prompt, history, options) => {
      try {
        return await config.primary.generate(prompt, history, options)
      } catch (primaryError) {
        if (config.fallback === undefined) {
          return dryRunResult(prompt, primaryError)
        }

        try {
          return await config.fallback.generate(prompt, history, options)
        } catch (fallbackError) {
          return dryRunResult(prompt, fallbackError)
        }
      }
    },
  }
}

function dryRunResult(prompt: string, error: unknown): GenerateResult {
  const reason = error instanceof Error ? error.message : '알 수 없는 오류'
  return {
    text: `현재 AI 응답을 제공할 수 없어요. 질문: ${prompt}\n사유: ${reason}`,
    toolRecords: [],
  }
}
