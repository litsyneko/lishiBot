import { logger } from '../../utils/logger'
import type { GenerateResult, ProviderAdapter } from './aiPolicy'

export type AiProviderChainConfig = {
  readonly fallbacks?: readonly ProviderAdapter[] | undefined
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
        const reason =
          primaryError instanceof Error
            ? primaryError.message
            : String(primaryError)

        if (config.fallbacks === undefined || config.fallbacks.length === 0) {
          logger.warn('AI', `primary 실패(${reason}) — 폴백 없음, dry-run 강등`)
          return dryRunResult()
        }

        logger.warn('AI', `primary 실패(${reason}) — 폴백 체인 실행`)
        let lastError: unknown = primaryError
        for (let i = 0; i < config.fallbacks.length; i++) {
          const fallback = config.fallbacks[i]
          if (fallback === undefined) continue
          try {
            return await fallback.generate(prompt, history, options)
          } catch (fallbackError) {
            lastError = fallbackError
            logger.warn(
              'AI',
              `폴백 [${i + 1}/${config.fallbacks.length}] 실패(${
                fallbackError instanceof Error
                  ? fallbackError.message
                  : String(fallbackError)
              }) — 다음 단계로 이동`
            )
          }
        }

        logger.warn(
          'AI',
          `모든 폴백 실패(${
            lastError instanceof Error ? lastError.message : String(lastError)
          }) — dry-run 강등`
        )
        return dryRunResult()
      }
    },
  }
}

function dryRunResult(): GenerateResult {
  return {
    text: '미안해요, 지금 AI 서버 상태가 좋지 않아서 대답하기 어려워요. 잠시 후에 다시 말 걸어주실 수 있을까요?',
    toolRecords: [],
  }
}
