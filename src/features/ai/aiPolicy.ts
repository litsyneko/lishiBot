export type ChatMessage = {
  readonly content: string
  readonly role: 'assistant' | 'user'
  readonly imageUrls?: readonly string[]
  readonly authorId?: string
  readonly sentAt?: string
  readonly replyToMessageId?: string
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
  readonly toolChoice?:
    | 'auto'
    | 'required'
    | { readonly type: 'tool'; readonly toolName: string }
  readonly systemPrompt?: string
  // 요청자가 응답을 중단할 때 provider SDK까지 전파하는 신호. 사용자 중지
  // 버튼·반복 가드·응답 기한이 모두 이 한 경로로 내려간다. 미지정이면
  // provider는 기존과 동일하게 중단 신호 없이 동작한다.
  readonly abortSignal?: AbortSignal | undefined
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
  /**
   * 이 provider가 이미지를 입력으로 받을 수 있는지. 미지정이면 false(미지원).
   *
   * 체인이 '이미지가 왔는데 이 provider는 못 받는다'를 판단해 건너뛸 때 쓴다.
   * 여기서 걸러야 폴백이 이미지 가능한 모델로 넘어갈 수 있다 — providerCore가
   * 요청을 만들 때 걸러내면 폴백을 시도하기도 전에 죽는다.
   */
  readonly supportsImages?: boolean | undefined
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
  readonly complete: (
    finalText: string,
    forceFinalText?: boolean
  ) => Promise<string | undefined>
  /**
   * 마지막으로 쌓인 사고 요약. 중단 시점에 세션에 함께 남길 수 있도록 호출부에
   * 내보내는 통로다.
   *
   * 왜 이게 필요한가: 사고는 최종 화면에서 버려진다(12줄 인용은 진행 중에만).
   * 데드라인이나 사용자 중단으로 턴이 끝나면 '답이 없었다'만 남고 AI가 그동안
   * 뭘 하고 있었는지 아무도 모른다. 전체 사고는 컨텍스트를 다 태우므로 최근
   * REASONING_SUMMARY_LIMIT 자만 잘라서 준다.
   */
  readonly takeReasoningSummary: () => string
  /** 최종 편집에 실제로 사용한 본문(반복 잘림·길이 제한 적용 후). */
  readonly takeFinalText: () => string
  /**
   * 렌더러가 소유한 자원을 명시적으로 해제한다. 멱등.
   *
   * 왜 complete()만으로 부족했나: complete()는 "정상 종결"일 때만 호출된다.
   * 스트리밍 도중 provider.generate 폴백이 던지고 complete()를 거치지 않은 경로가
   * 있었고, 그때 typing keepalive 인터벌(9초마다 typing 표시)이 영구히 살아남았다.
   * 채널에 계속 typing이 뜨고 중지 버튼은 눌려도 반응 없는 상태였다.
   *
   * 즉 이 포트는 "완료를 기억하는 것"을 "어떤 경로로든 해제를 강제하는 것"으로
   * 바꾼 장치다. 호출부는 스트리밍을 시작한 지점 이후의 모든 로직을
   * try { ... } finally { stream.dispose() }로 감싸야 한다.
   */
  readonly dispose: () => void
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
