import { logger } from '../../utils/logger'
import { ReadableStream } from 'node:stream/web'

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
  // 첫 바이트(헤더 수신 직후 첫 본문 바이트, 헤더 자체 대기 포함)까지의 상한(ms).
  // 미지정 시 비활성. 지정하면 이 시간 안에 아무 바이트도 안 오면 그 시도를
  // 실패로 보고 남은 시도 횟수만큼 재시도한다 — 서버가 큐에 쌓아 무응답으로
  // 가만히 있는 hang을 요청 단위에서 잡아낸다. 이때는 아직 바이트를 하나도
  // 소비하지 않았으므로 재시도해도 사용자에게 보인 내용이 없다.
  readonly firstByteTimeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 10_000

// 일시적 실패로 보고 재시도할 HTTP 상태코드.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
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
  // 첫 바이트 감시 타이머를 내린다. 첫 바이트가 도착하면 호출부가 이걸 불러
  // 이후 스트림은 전체 응답 타임아웃만 지킨다.
  readonly stopFirstByteTimer: () => void
}

// fetch()는 헤더 수신만으로 resolve된다. 본문 소비가 끝나거나 취소될 때까지
// 동일한 타임아웃을 유지해 SSE/JSON 바디의 무한 대기를 막는다.
// firstChunk는 waitForFirstByte가 이미 소비한 첫 바이트다. 재시도에서 살아남은
// 시도의 본문을 통째로 넘기려면 이 첫 조각을 스트림 앞에 되돌려 넣어야 한다.
function watchResponseBody(
  response: Response,
  timed: TimedSignal,
  firstChunk?: Uint8Array
): Response {
  if (response.body === null) {
    timed.cleanup()
    return response
  }

  const reader = response.body.getReader()
  let finished = false
  let consumerCancelled = false
  const finish = () => {
    if (finished) return
    finished = true
    timed.signal.removeEventListener('abort', onAbort)
    timed.cleanup()
  }
  const onAbort = () => {
    void reader.cancel(timed.signal.reason).catch(() => undefined)
    finish()
  }
  timed.signal.addEventListener('abort', onAbort, { once: true })
  if (timed.signal.aborted) onAbort()

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (firstChunk !== undefined) controller.enqueue(firstChunk)
    },
    async pull(controller) {
      if (timed.signal.aborted) {
        controller.error(timed.signal.reason)
        return
      }
      let rejectOnAbort: () => void = () => undefined
      const aborted = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(timed.signal.reason)
        timed.signal.addEventListener('abort', rejectOnAbort, { once: true })
      })
      try {
        const chunk = await Promise.race([reader.read(), aborted])
        if (consumerCancelled) return
        if (timed.signal.aborted) throw timed.signal.reason
        if (chunk.done) {
          finish()
          controller.close()
        } else {
          controller.enqueue(chunk.value)
        }
      } catch (error) {
        if (consumerCancelled) return
        finish()
        controller.error(error)
      } finally {
        timed.signal.removeEventListener('abort', rejectOnAbort)
      }
    },
    cancel(reason) {
      consumerCancelled = true
      finish()
      return reader.cancel(reason)
    },
  })
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  })
  return wrapped
}

// 호출자 signal(SDK가 넘긴 abort)과 타임아웃을 하나의 signal로 합친다.
// AbortSignal.any는 @types/node 18에 타입이 없어 수동 구현.
function withTimeout(
  outer: AbortSignal | null | undefined,
  timeoutMs: number,
  firstByteTimeoutMs: number | undefined
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

  // 첫 바이트 감시 타이머. 요청 전송부터 첫 본문 바이트 도착까지를 재고,
  // 초과하면 이 시도 전체를 중단한다(재시도 대상). 첫 바이트가 오면
  // stopFirstByteTimer()로 내린다 — 첫 바이트 이후엔 전체 응답 타임아웃만 남는다.
  const firstByteTimer =
    firstByteTimeoutMs !== undefined
      ? setTimeout(() => {
          controller.abort(
            new Error(`첫 바이트 타임아웃(${firstByteTimeoutMs / 1000}초 초과)`)
          )
        }, firstByteTimeoutMs)
      : undefined

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      if (firstByteTimer !== undefined) clearTimeout(firstByteTimer)
      outer?.removeEventListener('abort', onOuterAbort)
    },
    stopFirstByteTimer: () => {
      if (firstByteTimer !== undefined) clearTimeout(firstByteTimer)
    },
  }
}

// 첫 본문 바이트를 기다린다. 바디가 없으면 null(대기할 것 없음), 바이트가 오면
// 그 조각을 돌려준다. 첫 바이트 타이머가 먼저 울리면 timed.signal이 abort되므로
// reason(첫 바이트 타임아웃)을 그대로 던져 호출부 재시도 경로로 보낸다.
async function waitForFirstByte(
  response: Response,
  timed: TimedSignal
): Promise<Uint8Array | null> {
  if (response.body === null) return null

  const reader = response.body.getReader()
  let rejectOnAbort: () => void = () => undefined
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(timed.signal.reason)
    timed.signal.addEventListener('abort', rejectOnAbort, { once: true })
  })
  try {
    const chunk = await Promise.race([reader.read(), aborted])
    if (chunk.done) return null
    timed.stopFirstByteTimer()
    // 잠금을 풀어 watchResponseBody가 다시 getReader()할 수 있게 한다.
    reader.releaseLock()
    return chunk.value
  } finally {
    timed.signal.removeEventListener('abort', rejectOnAbort)
  }
}

export function createResilientFetch(
  config: ResilientFetchConfig
): typeof fetch {
  const maxAttempts = Math.max(1, config.maxAttempts ?? 1)
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS

  return async (input, init) => {
    const outerSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const attempts =
      isReplayableBody(init?.body) &&
      (!(input instanceof Request) || input.body === null)
        ? maxAttempts
        : 1
    let lastError: unknown

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (outerSignal?.aborted) throw outerSignal.reason
      const timed = withTimeout(
        outerSignal,
        timeoutMs,
        config.firstByteTimeoutMs
      )
      let handoff = false

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
          timed.cleanup()
          await sleep(backoffDelay(attempt), outerSignal ?? undefined)
          continue
        }

        // 첫 바이트 감시: 이 시간 안에 아무 바이트도 안 오면 그 시도를 실패로
        // 보고 재시도한다. 이때 소비한 바이트가 없으므로 재시도해도 사용자에게
        // 보인 내용이 없다. 첫 바이트 감시가 꺼져 있으면(null) 기존 경로 그대로.
        const first = await waitForFirstByte(response, timed)
        const watched = watchResponseBody(response, timed, first ?? undefined)
        handoff = true
        return watched
      } catch (err) {
        // 호출자가 직접 abort한 경우는 재시도하지 않고 그대로 전파.
        if (outerSignal?.aborted) {
          throw err
        }

        lastError = err
        if (attempt < attempts) {
          const reason = err instanceof Error ? err.message : String(err)
          logger.warn(
            'AI',
            `${config.label} 요청 실패(${reason}) — 재시도 ${attempt}/${attempts}`
          )
          timed.cleanup()
          await sleep(backoffDelay(attempt), outerSignal ?? undefined)
          continue
        }
      } finally {
        if (!handoff) timed.cleanup()
      }
    }

    throw lastError
  }
}
