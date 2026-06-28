/** AI가 툴을 연속 호출할 때 디스코드 API rate limit과 UI 부하를 줄이기 위한 대기 시간 (ms) */
export const TOOL_CALL_DELAY_MS = 800

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** AI 도구 호출 직전에 일정 시간 대기합니다. */
export function delayBeforeToolCall(): Promise<void> {
  return sleep(TOOL_CALL_DELAY_MS)
}
