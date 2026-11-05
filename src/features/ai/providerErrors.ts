import type { ToolRecord } from './aiPolicy'

/**
 * AI 턴이 사용자의 의도나 내부 규칙에 의해 중단됐다는 신호.
 *
 * 이 예외와 ToolExecutionInterruptedError를 분리하는 이유:
 * ToolExecutionInterruptedError는 '실패'다 — provider가 죽었으니 폴백 체인이
 * 대신 답하는 것이 정답이다. 반면 중단은 '실패가 아니라 의도'다. 사용자가
 * 멈추라고 눌렀는데 폴백 provider가 알아서 답을 이어가면, 사용자가 멈췄다는
 * 판단 자체가 무효가 된다. 그래서 중단은 폴백 체인에 흘려보내지 않는다.
 */
export type AiTurnAbortReason =
  | 'deadline'
  | 'external'
  | 'loop-guard'
  | 'user-stop'

export class AiTurnAbortedError extends Error {
  public constructor(
    public readonly reason: AiTurnAbortReason,
    public readonly toolRecords: readonly ToolRecord[] = []
  ) {
    super(`AI 응답 중단(${reason})`)
    this.name = 'AiTurnAbortedError'
  }
}

export function toolRecordsFromError(error: unknown): readonly ToolRecord[] {
  return error instanceof AiTurnAbortedError ||
    error instanceof ToolExecutionInterruptedError
    ? error.toolRecords
    : []
}

/** SDK가 중단 직후 다른 오류를 던져도 신호의 원래 사유와 도구 기록을 유지한다. */
export function abortedTurnFromSignal(
  error: unknown,
  signal: AbortSignal | undefined
): AiTurnAbortedError | undefined {
  if (error instanceof AiTurnAbortedError) return error
  if (!signal?.aborted && !isTurnAborted(error)) return undefined
  const reason = signal?.reason
  return new AiTurnAbortedError(
    reason instanceof AiTurnAbortedError ? reason.reason : 'external',
    toolRecordsFromError(error)
  )
}

export function throwIfTurnAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw (
    abortedTurnFromSignal(signal.reason, signal) ??
    new AiTurnAbortedError('external')
  )
}

// 중단 사유별 사용자 문구. 같은 '⏹️ 응답을 멈췄어요.'로 뭉개면 사용자가
// 자신이 누른 버튼 때문인지, 시간이 걸려 봇이 끊은 것인지 알 수 없다.
// deadline만 다른 문구를 쓰고, loop-guard는 1단계 loopGuard의 안내와 문체를
// 맞춘다.
const ABORT_NOTICES: Record<AiTurnAbortReason, string> = {
  'user-stop': '⏹️ 응답을 멈췄어요.',
  deadline: '⏰ 시간이 너무 오래 걸려 응답을 멈췄어요.',
  'loop-guard': '✂️ 같은 내용이 계속 반복돼 멈췄어요.',
  external: '⏹️ 응답을 멈췄어요.',
}

/** 중단 예외인지 판정한다. SDK 원본 AbortError도 중단으로 본다(직접 호출 경로 보호). */
export function isTurnAborted(error: unknown): boolean {
  return (
    error instanceof AiTurnAbortedError ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

/** 중단 사유를 사용자 노출 한국어 문구로 바꾼다. 중단이 아니면 undefined. */
export function describeAbortedTurn(error: unknown): string | undefined {
  if (error instanceof AiTurnAbortedError) {
    return ABORT_NOTICES[error.reason]
  }
  return isTurnAborted(error) ? ABORT_NOTICES.external : undefined
}

/** 도구 호출 뒤 요청이 중단되어 다른 모델에서 턴을 재실행하면 위험한 상태. */
export class ToolExecutionInterruptedError extends Error {
  readonly toolRecords: readonly ToolRecord[]

  constructor(cause: unknown, toolRecords: readonly ToolRecord[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'ToolExecutionInterruptedError'
    this.toolRecords = toolRecords
  }
}
