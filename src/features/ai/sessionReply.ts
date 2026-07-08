import type {
  ChatMessage,
  ProviderAdapter,
  ToolDefinitionInput,
} from './aiPolicy'
import {
  appendToSession,
  continueSession,
  formatToolHistoryForPrompt,
  getHistory,
  getOrCreateSession,
} from './conversationStore'
import { getMemoryStore } from './memoryStore'
import { formatServerContextForPrompt } from './serverProfile'
import { KOREAN_SYSTEM_PROMPT } from './systemPrompt'
import { stripThinkTags, stripToolCallSyntax } from './thinkStripper'

const FOOTER_HINT = '---\n\n-# 이 메시지에 답장하면 대화를 이어갈 수 있어요.'

export type SessionReplyInput = {
  readonly guildId: string
  readonly userId: string
  readonly referencedMessageId: string
  readonly provider: ProviderAdapter
  readonly userMessage: string
  readonly previousBotResponse: string
  readonly memberDisplayName?: string
  readonly guildName?: string
  readonly channelId: string
  readonly channelName?: string
  readonly hasManageGuild?: boolean
  readonly isOwner?: boolean
  readonly tools?: readonly ToolDefinitionInput[]
  // 길드에 등록된 슬래시 명령어 안내문 (commandCatalog.ts에서 생성)
  readonly commandCatalog?: string
}

export type SessionReplyResult = {
  readonly response: string
  readonly continuedFromSession: boolean
  readonly sessionKey: string
  readonly toolRecords?: readonly {
    name: string
    args: Record<string, unknown>
    result: unknown
    success: boolean
  }[]
}

export async function handleSessionReply(
  input: SessionReplyInput
): Promise<SessionReplyResult> {
  const {
    guildId,
    userId,
    referencedMessageId,
    provider,
    userMessage,
    previousBotResponse,
  } = input

  let sessionKey: string
  const continued = continueSession(referencedMessageId)
  if (continued !== undefined) {
    sessionKey = continued
  } else {
    sessionKey = getOrCreateSession(guildId, input.channelId, userId)
    appendToSession(sessionKey, {
      content: previousBotResponse,
      role: 'assistant',
    })
  }

  const displayName = input.memberDisplayName ?? '사용자'
  const guildName = input.guildName ?? '서버'
  const channelName = input.channelName ?? '현재 채널'
  const permissionInfo = input.isOwner
    ? '(권한: 서버 주인)'
    : input.hasManageGuild
    ? '(권한: 서버 관리자)'
    : '(권한: 일반 유저)'
  const contextPrefix = `[대화 중 - 사용자: ${displayName}] ${permissionInfo} (서버: ${guildName}, 채널: #${channelName})\n\n`
  const memoryBlock = await getMemoryStore().formatForPrompt(userId)
  const personalityBlock = await getMemoryStore().buildPersonalityPrompt(userId)
  const contextMessage = memoryBlock + contextPrefix + userMessage

  appendToSession(sessionKey, {
    content: contextPrefix + userMessage,
    role: 'user',
  })

  const history = getHistory(sessionKey).slice(0, -1) as ChatMessage[]
  const toolHistoryBlock = formatToolHistoryForPrompt(sessionKey)
  const serverContextBlock = await formatServerContextForPrompt(
    guildId,
    input.channelId
  )
  const promptParts = [
    KOREAN_SYSTEM_PROMPT,
    input.commandCatalog ?? '',
    serverContextBlock,
    personalityBlock,
    toolHistoryBlock,
  ].filter((part) => part.length > 0)
  const result = await provider.generate(contextMessage, history, {
    tools: input.tools,
    maxSteps: 20,
    systemPrompt: promptParts.length > 1 ? promptParts.join('\n\n') : undefined,
  })

  const cleaned = stripToolCallSyntax(stripThinkTags(result.text))
  appendToSession(sessionKey, { content: cleaned, role: 'assistant' })

  const usedTools =
    result.toolRecords.length > 0
      ? `\n\n> 사용: ${result.toolRecords.map((r) => r.name).join(', ')}`
      : ''

  return {
    response: `${cleaned}${usedTools}\n\n${FOOTER_HINT}`,
    continuedFromSession: true,
    sessionKey,
    toolRecords: result.toolRecords,
  }
}

export function startSession(
  guildId: string,
  channelId: string,
  userId: string,
  userPrompt: string,
  botResponse: string
): string {
  const sessionKey = getOrCreateSession(guildId, channelId, userId)
  appendToSession(sessionKey, { content: userPrompt, role: 'user' })
  appendToSession(sessionKey, { content: botResponse, role: 'assistant' })
  return sessionKey
}
