import { logger } from '../../utils/logger'
import type {
  ChatMessage,
  GenerateOptions,
  ProviderAdapter,
  StreamResult,
} from './aiPolicy'
import {
  AiTurnAbortedError,
  ToolExecutionInterruptedError,
} from './providerErrors'

export type AiProviderChainConfig = {
  readonly fallbacks?: readonly ProviderAdapter[] | undefined
  readonly primary: ProviderAdapter
}

/**
 * 중단은 실패가 아니라 사용자 의도다. 폴백 provider가 대신 답하면 사용자가
 * 멈춘다고 누른 의미가 사라지고, 루프 가드가 잘라낸 응답을 다른 모델이 통째로
 * 다시 써버린다. 그래서 폴백 체인 어디에도 흘려보내지 않는다.
 * SDK 원본 AbortError도 같이 잡아야 provider를 직접 호출하는 경로까지 막힌다.
 */
function isAbort(error: unknown): boolean {
  return (
    error instanceof AiTurnAbortedError ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

/**
 * 신호가 이미 올라온 상태로 체인에 들어오면 신호의 중단 사유를 유지한다.
 *
 * 왜 사후 예외 검사(isAbort)만으로 부족했나: generateText/streamText는 abort된
 * signal이어도 요청을 시작하기 전에 AbortError가 아닌 다른 오류(인증 실패, 잘못된
 * 요청 형식 등)를 먼저 던질 수 있다. 그러면 isAbort가 false가 되어 폴백 루프가
 * 돌고, 끝내 dryRunResult()를 반환한다 — 사용자가 중지를 눌렀는데 "AI 서버 상태가
 * 좋지 않아요"라는 사과를 받고, 그 사과문까지 세션에 원문으로 저장된다.
 *
 * 입구에서 선검사하면 예외 분류가 정확하다는 운에 기대지 않고 구조적으로 막힌다.
 */
function throwIfAlreadyAborted(options: GenerateOptions | undefined): void {
  if (options?.abortSignal?.aborted === true) {
    const reason = options.abortSignal.reason
    throw reason instanceof AiTurnAbortedError
      ? reason
      : new AiTurnAbortedError('external')
  }
}

// ─── 이미지 라우팅 ───

/**
 * 이 provider가 이미지를 받을 수 있는지. 미지정이면 false(미지원) — config의
 * supportsImages는 명시적 opt-in이라 추측해 true를 주지 않는다.
 */
function canProviderTakeImages(provider: ProviderAdapter): boolean {
  return provider.supportsImages === true
}

/**
 * 원본 options에서 imageUrls만 제거한 사본. 원본을 바꾸면 호출부가 thinking 중
 * 화면이나 도구 입력에 기대하는 값이 함께 바뀌므로 반드시 사본을 쓴다.
 */
function withoutImages(
  options: GenerateOptions | undefined
): GenerateOptions | undefined {
  if (options === undefined || options.imageUrls === undefined) {
    return options
  }
  const { imageUrls: _dropped, ...rest } = options
  return rest
}

function hasImages(options: GenerateOptions | undefined): boolean {
  return (options?.imageUrls?.length ?? 0) > 0
}

function historyForMode(
  history: readonly ChatMessage[] | undefined,
  mode: ProviderImageMode
): readonly ChatMessage[] | undefined {
  if (mode !== 'text-only') return history
  return history?.map(({ imageUrls: _dropped, ...message }) => message)
}

function hasAnyImages(
  history: readonly ChatMessage[] | undefined,
  options: GenerateOptions | undefined
): boolean {
  return (
    hasImages(options) ||
    (history?.some((message) => hasImages(message)) ?? false)
  )
}

/**
 * 이미지 지원 provider가 체인 전체에 하나라도 있는지.
 *
 * 아무도 없으면 '이미지 미지원이라 건너뛰기'를 하면 아무 provider도 남지 않는다.
 * 그때는 primary를 이미지만 뺀 채로 **호출**해 텍스트라도 처리한다(F3).
 */
function chainCanTakeImages(
  primary: ProviderAdapter,
  fallbacks: readonly ProviderAdapter[]
): boolean {
  return (
    canProviderTakeImages(primary) ||
    fallbacks.some((fallback) => canProviderTakeImages(fallback))
  )
}

/**
 * provider 하나의 이미지 처리 방식을 결정한다.
 *
 * - canTake: 이미지를 그대로 받고 호출한다.
 * - text-only: 이미지를 뺀 채로 호출한다(지원 모델이 없거나 모두 실패한 뒤).
 * - skip: 이미지 지원 provider를 우선 시도할 동안 호출을 미룬다.
 *
 * 왜 provider별로 독립적으로 판단하는가: 이미지 지원 capability는 **provider별
 * 독립 속성**이다. 여기서 한 provider의 판정을 다른 provider에 전파하면
 * 실제로 이미지를 읽을 수 있는 모델까지 이미지를 빼버린다. 요구사항은
 * "이미지를 못 읽으면 **이미지를 읽을 수 있는 폴백을 찾아 그 모델을 실행**"인데,
 * 전파되는 판정은 정확히 그 요구를 무력화한다(실측으로 확인된 버그).
 */
type ProviderImageMode = 'canTake' | 'skip' | 'text-only'

function imageModeFor(
  imagesPresent: boolean,
  provider: ProviderAdapter,
  anyProviderCanTakeImages: boolean
): ProviderImageMode {
  if (!imagesPresent) {
    return 'canTake'
  }
  if (canProviderTakeImages(provider)) {
    return 'canTake'
  }
  return anyProviderCanTakeImages ? 'skip' : 'text-only'
}

/**
 * 로그 문구는 **실제 동작과 일치해야 한다.** 운영자가 "왜 이 provider가 선택됐지?"
 * 를 로그만으로 답할 수 있어야 한다.
 * - skip: 실제로 호출하지 않았다. '건너뜁니다'
 * - text-only: 호출했다. 단 이미지가 빠져 있다. '텍스트만으로 처리합니다'
 */
function logImageMode(
  label: string,
  position: string,
  mode: ProviderImageMode
): void {
  if (mode === 'skip') {
    logger.info(
      'AI',
      `${position} ${label}: 이미지 미지원(config의 supportsImages 미지정/명시적 false)이므로 이 provider를 건너뜁니다`
    )
    return
  }
  if (mode === 'text-only') {
    logger.info(
      'AI',
      `${position} ${label}: 이미지를 제외하고 텍스트만으로 처리합니다`
    )
  }
}

/** 모드에 맞춰 실제 넘길 options를 고른다. */
function optionsForMode(
  options: GenerateOptions | undefined,
  mode: ProviderImageMode
): GenerateOptions | undefined {
  return mode === 'text-only' ? withoutImages(options) : options
}

function promptForMode(prompt: string, mode: ProviderImageMode): string {
  if (mode !== 'text-only') return prompt
  return `${prompt}\n\n[이미지 입력은 이 모델에 전달되지 않았습니다. 이미지를 본 것처럼 추측하지 말고 텍스트로 확인 가능한 내용만 답하세요.]`
}

/**
 * 아무 provider도 이미지를 읽지 못하는 상태에서의 최종 문구.
 *
 * 왜 일반 dryRun 사과문을 쓰지 않는가(F3): "AI 서버 상태가 좋지 않아요"는 사실과
 * 다르다. 서버는 멀쩡하고 **이미지를 읽는 모델이 연결되어 있지 않다**는 전혀
 * 다른 문제다. 사용자가 "내 이미지를 봤나?" 하고 알고 싶어 하는 정확히 그 지점이다.
 *
 * 왜 체인이 직접 문구를 만들며 호출부에 노출하지 않는가: 이 체인은 최종 텍스트를
 * 만들어 돌려주는 곳이라, 모든 강등 경로(dryRun·중단·도구 인터럽트)도 이미 여기서
 * 문구를 만든다. 판단 근거(체인 전체에 이미지 지원 provider가 없었다는 사실)를
 * 여기서 로그로 남기고, 사용자에게는 그 사실과 같은 문구를 보낸다. 호출부에
 * 플래그를 위로 노출하면 그 정보가 세션·화면·안내 3곳에 흩어져 같은 말을 세 번
 * 관리하게 되므로, 판단과 표시를 한 곳에 모으는 편이 정직하다.
 */
function dryRunResultForImages(): StreamResult {
  return {
    text: '이미지를 읽을 수 있는 모델이 연결되어 있지 않고 텍스트 응답도 실패했어요. 이미지 질문이시면 글자로 적어 다시 물어봐 주세요.',
    toolRecords: [],
    reasoning: '',
  }
}

/** 이미지가 있었는데 아무도 못 받았을 때 최종 문구를 고른다. */
function terminalResult(imagesPresent: boolean): StreamResult {
  return imagesPresent ? dryRunResultForImages() : dryRunResult()
}

export function createAiProviderChain(
  config: AiProviderChainConfig
): ProviderAdapter {
  const fallbacks = config.fallbacks ?? []

  return {
    label: config.primary.label,
    generate: async (prompt, history, options) => {
      throwIfAlreadyAborted(options)
      const imagesPresent = hasAnyImages(history, options)
      const anyCanTake = chainCanTakeImages(config.primary, fallbacks)
      const primaryMode = imageModeFor(
        imagesPresent,
        config.primary,
        anyCanTake
      )
      logImageMode(config.primary.label ?? 'primary', 'primary', primaryMode)

      if (primaryMode !== 'skip') {
        try {
          return await config.primary.generate(
            promptForMode(prompt, primaryMode),
            historyForMode(history, primaryMode),
            optionsForMode(options, primaryMode)
          )
        } catch (primaryError) {
          throwIfAlreadyAborted(options)
          if (isAbort(primaryError)) throw primaryError
          if (primaryError instanceof ToolExecutionInterruptedError) {
            return interruptedResult(primaryError)
          }
          const reason = describe(primaryError)

          if (fallbacks.length === 0) {
            logger.warn(
              'AI',
              `primary 실패(${reason}) — 폴백 없음, dry-run 강등`
            )
            return terminalResult(imagesPresent && !anyCanTake)
          }
          logger.warn('AI', `primary 실패(${reason}) — 폴백 체인 실행`)
        }
      }

      let lastError: unknown = new Error('폴백 미도달')
      for (let i = 0; i < fallbacks.length; i++) {
        const fallback = fallbacks[i]
        if (fallback === undefined) continue
        const label = fallbackLabel(fallback, i)
        // 판정은 이 폴백 자신의 supportsImages만 본다. primary의 판정을 OR하지
        // 않는 것이 F1의 근본 수정이다.
        const mode = imageModeFor(imagesPresent, fallback, anyCanTake)
        logImageMode(label, `폴백 ${i + 1}`, mode)
        if (mode === 'skip') {
          continue
        }
        try {
          return await fallback.generate(
            promptForMode(prompt, mode),
            historyForMode(history, mode),
            optionsForMode(options, mode)
          )
        } catch (fallbackError) {
          throwIfAlreadyAborted(options)
          if (isAbort(fallbackError)) throw fallbackError
          if (fallbackError instanceof ToolExecutionInterruptedError) {
            return interruptedResult(fallbackError)
          }
          lastError = fallbackError
          logger.warn(
            'AI',
            `폴백 [${i + 1}/${fallbacks.length}] 실패(${describe(
              fallbackError
            )}) — 다음 단계로 이동`
          )
        }
      }

      // 이미지 가능 모델이 모두 실패했다면, 아직 호출하지 않은 텍스트 전용
      // provider로 마지막 강등을 시도한다. 이미 실행한 모델은 재실행하지 않는다.
      if (imagesPresent && anyCanTake) {
        for (const provider of [config.primary, ...fallbacks]) {
          if (canProviderTakeImages(provider)) continue
          try {
            return await provider.generate(
              promptForMode(prompt, 'text-only'),
              historyForMode(history, 'text-only'),
              withoutImages(options)
            )
          } catch (error) {
            throwIfAlreadyAborted(options)
            if (isAbort(error)) throw error
            if (error instanceof ToolExecutionInterruptedError)
              return interruptedResult(error)
            lastError = error
            logger.warn('AI', `텍스트 전용 폴백 실패(${describe(error)})`)
          }
        }
      }

      logger.warn('AI', `모든 폴백 실패(${describe(lastError)}) — dry-run 강등`)
      return terminalResult(imagesPresent && !anyCanTake)
    },
    // generate와 같은 폴백 의미를 스트리밍에 그대로 적용한다. 단 한 가지가
    // 다르다 — 이미 사용자에게 노출된 내용이 있으므로 provider가 바뀔 때마다
    // onProviderSwitch로 통지해 호출부가 노출 내용을 초기화하게 한다.
    stream: async (prompt, history, options, handlers) => {
      throwIfAlreadyAborted(options)
      const imagesPresent = hasAnyImages(history, options)
      const anyCanTake = chainCanTakeImages(config.primary, fallbacks)
      const primaryMode = imageModeFor(
        imagesPresent,
        config.primary,
        anyCanTake
      )
      logImageMode(config.primary.label ?? 'primary', 'primary', primaryMode)

      if (primaryMode !== 'skip') {
        try {
          return await config.primary.stream(
            promptForMode(prompt, primaryMode),
            historyForMode(history, primaryMode),
            optionsForMode(options, primaryMode),
            handlers
          )
        } catch (primaryError) {
          throwIfAlreadyAborted(options)
          if (isAbort(primaryError)) throw primaryError
          if (primaryError instanceof ToolExecutionInterruptedError) {
            return interruptedResult(primaryError)
          }
          const reason = describe(primaryError)

          if (fallbacks.length === 0) {
            logger.warn(
              'AI',
              `primary 스트리밍 실패(${reason}) — 폴백 없음, dry-run 강등`
            )
            return terminalResult(imagesPresent && !anyCanTake)
          }
          logger.warn('AI', `primary 스트리밍 실패(${reason}) — 폴백 체인 실행`)
        }
      }

      let lastError: unknown = new Error('폴백 미도달')
      for (let i = 0; i < fallbacks.length; i++) {
        const fallback = fallbacks[i]
        if (fallback === undefined) continue
        const label = fallbackLabel(fallback, i)
        const mode = imageModeFor(imagesPresent, fallback, anyCanTake)
        logImageMode(label, `폴백 ${i + 1}`, mode)
        if (mode === 'skip') {
          continue
        }
        try {
          handlers.onProviderSwitch?.(label)
          return await fallback.stream(
            promptForMode(prompt, mode),
            historyForMode(history, mode),
            optionsForMode(options, mode),
            handlers
          )
        } catch (fallbackError) {
          throwIfAlreadyAborted(options)
          if (isAbort(fallbackError)) throw fallbackError
          if (fallbackError instanceof ToolExecutionInterruptedError) {
            return interruptedResult(fallbackError)
          }
          lastError = fallbackError
          logger.warn(
            'AI',
            `폴백 [${i + 1}/${
              fallbacks.length
            }](${label}) 스트리밍 실패(${describe(
              fallbackError
            )}) — 다음 단계로 이동`
          )
        }
      }

      if (imagesPresent && anyCanTake) {
        for (const provider of [config.primary, ...fallbacks]) {
          if (canProviderTakeImages(provider)) continue
          try {
            handlers.onProviderSwitch?.(provider.label ?? '텍스트 전용 폴백')
            return await provider.stream(
              promptForMode(prompt, 'text-only'),
              historyForMode(history, 'text-only'),
              withoutImages(options),
              handlers
            )
          } catch (error) {
            throwIfAlreadyAborted(options)
            if (isAbort(error)) throw error
            if (error instanceof ToolExecutionInterruptedError)
              return interruptedResult(error)
            lastError = error
            logger.warn(
              'AI',
              `텍스트 전용 폴백 스트리밍 실패(${describe(error)})`
            )
          }
        }
      }

      logger.warn(
        'AI',
        `모든 폴백 스트리밍 실패(${describe(lastError)}) — dry-run 강등`
      )
      return terminalResult(imagesPresent && !anyCanTake)
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
