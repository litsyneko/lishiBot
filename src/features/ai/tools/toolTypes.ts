// ─── Tool Function Declaration (Gemini API format) ───

export type ToolFunctionDeclaration = {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: 'object'
    readonly properties: Record<string, ToolParameterSchema>
    readonly required: readonly string[]
  }
}

export type ToolParameterSchema = {
  readonly type: string
  readonly description: string
  readonly enum?: readonly string[]
}

// ─── Gemini Function Call / Response ───

export type ToolCall = {
  readonly name: string
  readonly args: Record<string, unknown>
}

export type ToolResponse = {
  readonly name: string
  readonly response: Record<string, unknown>
}

// ─── Tool Execution ───

export type ToolResult = {
  readonly success: boolean
  readonly message: string
  readonly data?: Record<string, unknown>
  readonly summary?: string
}

export type ToolExecutionContext = {
  readonly guildId: string
  readonly guildName: string
  readonly userId: string
  readonly channelId: string
}

// ─── Permission ───

export type ToolPermission = {
  readonly requireManageGuild: boolean
  readonly requireAdmin: boolean
  readonly risk?: 'info' | 'warning' | 'danger'
  readonly runtimeCheck?: (
    args: Record<string, unknown>,
    guildId: string,
    userId: string
  ) => string | null
}

export type PermissionCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

// ─── Tool Definition ───

export type ToolDefinition = {
  readonly declaration: ToolFunctionDeclaration
  readonly permission: ToolPermission
  readonly hidden?: boolean
  readonly execute: (
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ) => Promise<ToolResult>
}

// ─── Tool Registry ───

export type ToolRegistry = {
  readonly get: (name: string) => ToolDefinition | undefined
  readonly getAll: () => ToolDefinition[]
  readonly register: (definition: ToolDefinition) => void
  readonly toFunctionDeclarations: () => ToolFunctionDeclaration[]
}

// ─── Proposal ───

export type ProposalInfo = {
  readonly toolName: string
  readonly args: Record<string, unknown>
  readonly description: string
  readonly severity: 'info' | 'warning' | 'danger'
}
