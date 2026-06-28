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
  readonly tools?: readonly ToolDefinitionInput[]
  readonly maxSteps?: number
  readonly systemPrompt?: string
}

export type GenerateResult = {
  readonly text: string
  readonly toolRecords: readonly ToolRecord[]
}

export type ProviderAdapter = {
  readonly generate: (
    prompt: string,
    history?: readonly ChatMessage[],
    options?: GenerateOptions
  ) => Promise<GenerateResult>
}

export function assertCanUseAiManagement(input: AiPermissionInput): void {
  if (!input.administrator && !input.manageGuild) {
    throw new Error(
      '서버 관리 권한이 있는 사용자만 AI 관리 기능을 사용할 수 있어요.'
    )
  }
}
