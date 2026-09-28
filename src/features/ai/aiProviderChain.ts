import { logger } from '../../utils/logger'
import type { ProviderAdapter, StreamResult } from './aiPolicy'
import { ToolExecutionInterruptedError } from './providerErrors'

export type AiProviderChainConfig = {
  readonly fallbacks?: readonly ProviderAdapter[] | undefined
  readonly primary: ProviderAdapter
}

export function createAiProviderChain(
  config: AiProviderChainConfig
): ProviderAdapter {
  return {
    label: config.primary.label,
    generate: async (prompt, history, options) => {
      try {
        return await config.primary.generate(prompt, history, options)
      } catch (primaryError) {
        if (primaryError instanceof ToolExecutionInterruptedError) {
          return interruptedResult(primaryError)
        }
        const reason = describe(primaryError)

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
            if (fallbackError instanceof ToolExecutionInterruptedError) {
              return interruptedResult(fallbackError)
            }
            lastError = fallbackError
            logger.warn(
              'AI',
              `폴백 [${i + 1}/${config.fallbacks.length}] 실패(${describe(
                fallbackError
              )}) — 다음 단계로 이동`
            )
          }
        }

        logger.warn(
          'AI',
          `모든 폴백 실패(${describe(lastError)}) — dry-run 강등`
        )
        return dryRunResult()
      }
    },
    // generate와 같은 폴백 의미를 스트리밍에 그대로 적용한다. 단 한 가지가
    // 다르다 — 이미 사용자에게 노출된 내용이 있으므로 provider가 바뀔 때마다
    // onProviderSwitch로 통지해 호출부가 노출 내용을 초기화하게 한다.
    stream: async (prompt, history, options, handlers) => {
      try {
        return await config.primary.stream(prompt, history, options, handlers)
      } catch (primaryError) {
        if (primaryError instanceof ToolExecutionInterruptedError) {
          return interruptedResult(primaryError)
        }
        const reason = describe(primaryError)

        if (config.fallbacks === undefined || config.fallbacks.length === 0) {
          logger.warn(
            'AI',
            `primary 스트리밍 실패(${reason}) — 폴백 없음, dry-run 강등`
          )
          return dryRunResult()
        }

        logger.warn('AI', `primary 스트리밍 실패(${reason}) — 폴백 체인 실행`)
        let lastError: unknown = primaryError
        for (let i = 0; i < config.fallbacks.length; i++) {
          const fallback = config.fallbacks[i]
          if (fallback === undefined) continue
          const label = fallbackLabel(fallback, i)
          try {
            handlers.onProviderSwitch?.(label)
            return await fallback.stream(prompt, history, options, handlers)
          } catch (fallbackError) {
            if (fallbackError instanceof ToolExecutionInterruptedError) {
              return interruptedResult(fallbackError)
            }
            lastError = fallbackError
            logger.warn(
              'AI',
              `폴백 [${i + 1}/${
                config.fallbacks.length
              }](${label}) 스트리밍 실패(${describe(
                fallbackError
              )}) — 다음 단계로 이동`
            )
          }
        }

        logger.warn(
          'AI',
          `모든 폴백 스트리밍 실패(${describe(lastError)}) — dry-run 강등`
        )
        return dryRunResult()
      }
    },
  }
}

function fallbackLabel(fallback: ProviderAdapter, index: number): string {
  return fallback.label ?? `폴백 ${index + 1}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function dryRunResult(): StreamResult {
  return {
    text: '미안해요, 지금 AI 서버 상태가 좋지 않아서 대답하기 어려워요. 잠시 후에 다시 말 걸어주실 수 있을까요?',
    toolRecords: [],
    reasoning: '',
  }
}

function interruptedResult(error: ToolExecutionInterruptedError): StreamResult {
  logger.warn('AI', `도구 호출 후 요청 중단(${error.message}) — 중복 실행 방지`)
  return {
    text: '도구 호출 중 응답이 끊겼어요. 같은 작업을 다시 실행하기 전에 결과를 확인해 주세요.',
    toolRecords: error.toolRecords,
    reasoning: '',
  }
}
