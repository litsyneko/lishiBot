import { logger } from '../../utils/logger'

// OpenAI-호환 엔드포인트(zai-proxy, Ollama 등)로 나가는 HTTP 요청에
// 시도당 타임아웃 + 재시도를 입히는 fetch 래퍼.
//
// 재시도를 generateText 턴 단위가 아니라 HTTP 요청 단위로 거는 이유:
// 턴을 통째로 재시도하면 이미 실행된 도구(메시지 전송·삭제 등)가 중복
// 실행될 수 있다. 요청 단위 재시도는 도구 부작용 없이 안전하다.
export type ResilientFetchConfig = {
  // 로그 라벨(어느 provider의 요청인지 구분용)
  readonly label: string
  // 요청당 총 시도 횟수(첫 시도 포함). 미지정 시 1 = 재시도 없음.
  readonly maxAttempts?: number
  // 시도 1회당 응답 타임아웃(ms). 초과 시 그 시도를 중단하고 재시도.
  readonly requestTimeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 10_000

// 일시적 실패로 보고 재시도할 HTTP 상태코드.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS)
}

// 본문을 다시 보낼 수 있는 경우에만 재시도한다. 스트림 본문은 한 번
// 소비되면 재전송이 불가능하므로 단일 시도로 강등.
function isReplayableBody(body: unknown): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof Uint8Array ||
    body instanceof URLSearchParams
  )
}

type TimedSignal = {
  readonly signal: AbortSignal
  readonly cleanup: () => void
}

// 호출자 signal(SDK가 넘긴 abort)과 타임아웃을 하나의 signal로 합친다.
// AbortSignal.any는 @types/node 18에 타입이 없어 수동 구현.
function withTimeout(
  outer: AbortSignal | null | undefined,
  timeoutMs: number
): TimedSignal {
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort(outer?.reason)

  if (outer !== null && outer !== undefined) {
    if (outer.aborted) {
      controller.abort(outer.reason)
    } else {
      outer.addEventListener('abort', onOuterAbort, { once: true })
    }
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(`응답 타임아웃(${timeoutMs / 1000}초 초과)`))
  }, timeoutMs)

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    },
  }
}

export function createResilientFetch(
  config: ResilientFetchConfig
): typeof fetch {
  const maxAttempts = Math.max(1, config.maxAttempts ?? 1)
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS

  return async (input, init) => {
    const attempts = isReplayableBody(init?.body) ? maxAttempts : 1
    let lastError: unknown

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const timed = withTimeout(init?.signal, timeoutMs)

      try {
        // Request 객체는 본문이 1회용이라 시도마다 clone해서 넘긴다.
        const target = input instanceof Request ? input.clone() : input
        const response = await fetch(target, { ...init, signal: timed.signal })

        if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
          void response.body?.cancel().catch(() => undefined)
          logger.warn(
            'AI',
            `${config.label} HTTP ${response.status} — 재시도 ${attempt}/${attempts}`
          )
          await sleep(backoffDelay(attempt))
          continue
        }

        return response
      } catch (err) {
        // 호출자가 직접 abort한 경우는 재시도하지 않고 그대로 전파.
        if (init?.signal?.aborted) {
          throw err
        }

        lastError = err
        if (attempt < attempts) {
          const reason = err instanceof Error ? err.message : String(err)
          logger.warn(
            'AI',
            `${config.label} 요청 실패(${reason}) — 재시도 ${attempt}/${attempts}`
          )
          await sleep(backoffDelay(attempt))
          continue
        }
      } finally {
        timed.cleanup()
      }
    }

    throw lastError
  }
}
