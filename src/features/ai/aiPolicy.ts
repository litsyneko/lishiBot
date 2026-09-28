export type ChatMessage = {
  readonly content: string
  readonly role: 'assistant' | 'user'
}

export type AiPermissionInput = {
  readonly administrator: boolean
  readonly manageGuild: boolean
}

export type ToolCallInfo = {
  readonly name: string
  readonly args: Record<string, unknown>
}

export type ToolRecord = {
  readonly name: string
  readonly args: Record<string, unknown>
  readonly result: unknown
  readonly success: boolean
}

export type ToolDefinitionInput = {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: 'object'
    readonly properties: Record<
      string,
      {
        readonly type: string
        readonly description: string
        readonly enum?: readonly string[]
        readonly items?: {
          readonly type: string
          readonly description?: string
        }
      }
    >
    readonly required: readonly string[]
  }
  readonly execute: (args: Record<string, unknown>) => Promise<unknown>
}

export type GenerateOptions = {
  readonly imageUrls?: readonly string[]
  readonly tools?: readonly ToolDefinitionInput[]
  readonly maxSteps?: number
  readonly systemPrompt?: string
}

export type GenerateResult = {
  readonly text: string
  readonly toolRecords: readonly ToolRecord[]
}

/**
 * 스트리밍 델타 수신 콜백. 모두 선택 사항이라 provider는 필요한 것만 채운다.
 * - onReasoning: 사고(thinking) 토큰. 스트리밍 중에 사용자 화면에 노출된다.
 * - onText: 최종 본문 토큰.
 * - onToolCall: 도구 실행 시작. 단계 표시용.
 * - onProviderSwitch: 스트리밍 도중 폴백 provider로 넘어갔다는 통지.
 *   이미 노출된 내용이 있으므로 호출부는 이 신호를 보고 버퍼를 초기화해야 한다.
 */
export type StreamHandlers = {
  readonly onProviderSwitch?: (label: string) => void
  readonly onReasoning?: (delta: string) => void
  readonly onText?: (delta: string) => void
  readonly onToolCall?: (name: string) => void
}

// generate의 기존 계약({ text, toolRecords })을 그대로 유지한 채 스트리밍
// 경로에서만 필요한 값(사고 누적본·종료 사유)을 덧붙인다.
export type StreamResult = GenerateResult & {
  readonly reasoning: string
  readonly finishReason?: string | undefined
}

export type ProviderAdapter = {
  // 로그·폴백 통지용 이름. 미지정 시 provider가 스스로 정한 기본 라벨.
  readonly label?: string | undefined
  readonly generate: (
    prompt: string,
    history?: readonly ChatMessage[],
    options?: GenerateOptions
  ) => Promise<GenerateResult>
  readonly stream: (
    prompt: string,
    history: readonly ChatMessage[] | undefined,
    options: GenerateOptions | undefined,
    handlers: StreamHandlers
  ) => Promise<StreamResult>
}

/**
 * 스트리밍 델타를 받아 사용자 화면(Discord 메시지) 하나를 갱신하는 출력 포트.
 * 호출부는 스트리밍 델타를 직접 다루지 않고 이것만 조작한다.
 */
export type AiStreamOutput = {
  readonly appendReasoning: (delta: string) => void
  readonly appendText: (delta: string) => void
  readonly noteToolCall: (name: string) => void
  readonly noteProviderSwitch: (label: string) => void
  /**
   * 스트리밍 종료. 누적된 본문을 finalText로 확정하고 한 번 더 편집한다.
   * 화면에 남은 메시지 id를 돌려주며, 아무것도 띄울 수 없었다면 undefined를
   * 돌려준다(호출부가 최종 문안을 직접 보내야 한다). 항상 settle 된다.
   */
  readonly complete: (finalText: string) => Promise<string | undefined>
}

/** 스트리밍 메시지가 첫 내용을 띄우는 순간 호출부에 알리는 훅. */
export type AiStreamOpenHooks = {
  readonly onFirstContent: () => void
}

export function assertCanUseAiManagement(input: AiPermissionInput): void {
  if (!input.administrator && !input.manageGuild) {
    throw new Error(
      '서버 관리 권한이 있는 사용자만 AI 관리 기능을 사용할 수 있어요.'
    )
  }
}
