import type { ToolRecord } from './aiPolicy'

/** 도구 호출 뒤 요청이 중단되어 다른 모델에서 턴을 재실행하면 위험한 상태. */
export class ToolExecutionInterruptedError extends Error {
  readonly toolRecords: readonly ToolRecord[]

  constructor(cause: unknown, toolRecords: readonly ToolRecord[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'ToolExecutionInterruptedError'
    this.toolRecords = toolRecords
  }
}
