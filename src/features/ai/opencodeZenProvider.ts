import type { ProviderAdapter } from './aiPolicy'
import { runGenerate, runStream } from './providerCore'
import { createResilientFetch } from './resilientFetch'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

export type OpencodeZenConfig = {
  readonly apiKey: string
  readonly model: string
  // OpenAI-호환 엔드포인트. 미지정 시 OpenCode Zen 기본.
  readonly baseUrl?: string
  // 로그 라벨. 미지정 시 'OpenCode Zen'.
  readonly label?: string
  // HTTP 요청당 총 시도 횟수(첫 시도 포함). 미지정 시 1.
  readonly maxAttempts?: number
  // 시도 1회당 응답 타임아웃(ms). 미지정 시 60초.
  readonly requestTimeoutMs?: number
  // 생각(추론) 노력. 미지정 시 엔드포인트 기본값.
  readonly reasoningEffort?: string
  // 생성 온도. 미지정 시 SDK/엔드포인트 기본값(로컬은 호출부에서 0.2 지정).
  readonly temperature?: number
  // 컨텍스트 예산(토큰). 히스토리를 이 안에 맞춰 넣는다.
  readonly contextTokens?: number
}

const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

export function createOpencodeZenProvider(
  config: OpencodeZenConfig
): ProviderAdapter {
  if (config.apiKey.trim().length === 0) {
    throw new Error('OpenAI-호환 provider API 키를 입력해 주세요.')
  }

  const baseUrl = config.baseUrl?.trim()
  const label = config.label ?? 'OpenCode Zen'

  const provider = createOpenAICompatible({
    name: 'opencode-zen',
    baseURL:
      baseUrl !== undefined && baseUrl.length > 0
        ? baseUrl
        : OPENCODE_ZEN_BASE_URL,
    apiKey: config.apiKey,
    // 무응답/일시 오류 대응: 요청당 타임아웃 + 재시도 (재시도는 HTTP 요청
    // 단위라 이미 실행된 도구가 중복 실행되지 않는다).
    fetch: createResilientFetch({
      label,
      maxAttempts: config.maxAttempts,
      requestTimeoutMs: config.requestTimeoutMs,
    }),
  })
  const model = provider(config.model)

  return {
    label,
    generate: async (prompt, history, options) =>
      runGenerate({
        model,
        modelName: config.model,
        label,
        prompt,
        history,
        options,
        reasoningEffort: config.reasoningEffort,
        temperature: config.temperature,
        contextTokens: config.contextTokens,
      }),
    // 스트리밍 미지원 환경(로컬 모델의 tool-call 루프 충돌 등)에서의 안전망은
    // runStream 내부에 있다 — 노출된 토큰이 없으면 generate로 조용히 강등된다.
    stream: async (prompt, history, options, handlers) =>
      runStream(
        {
          model,
          modelName: config.model,
          label,
          prompt,
          history,
          options,
          reasoningEffort: config.reasoningEffort,
          temperature: config.temperature,
          contextTokens: config.contextTokens,
        },
        handlers
      ),
  }
}
