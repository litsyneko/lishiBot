import { logger } from '../../utils/logger'
import type {
  AiStreamOutput,
  ChatMessage,
  ProviderAdapter,
  StreamResult,
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
  readonly imageUrls?: readonly string[]
  readonly previousBotResponse: string
  readonly memberDisplayName?: string
  readonly guildName?: string
  readonly channelId: string
  readonly channelName?: string
  readonly hasManageGuild?: boolean
  readonly isOwner?: boolean
  // 요청자의 핵심 관리 권한 요약(permissionSummary.ts). AI가 작업 가능 여부를 먼저 판단하는 데 쓴다.
  readonly permissionSummary?: string
  readonly tools?: readonly ToolDefinitionInput[]
  // 길드에 등록된 슬래시 명령어 안내문 (commandCatalog.ts에서 생성)
  readonly commandCatalog?: string
  // 스트리밍 출력 포트. 미지정이면 generate 경로로 그대로 동작한다.
  readonly openStream?: AiStreamOutput
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
  /**
   * 스트리밍 메시지 id. 있으면 response가 이미 그 메시지에 실려 있으므로
   * 호출부는 reply()로 다시 보내지 않는다(이중 전송 방지).
   */
  readonly streamedMessageId?: string
}

// 본문이 비었을 때 조용히 빈 메시지를 보내지 않도록 한국어로 설명한다.
// thinking이 토큰 예산을 다 써서 content:"" + finish_reason:"length"가 오는
// 경우가 실제로 관측된다.
const EMPTY_RESPONSE_NOTICE =
  '💭 이번엔 대답을 끝내지 못했어요. 조금 뒤에 다시 물어봐 주세요.'
const LENGTH_CUT_NOTICE =
  '✂️ 응답이 너무 길어 잘렸어요. 질문을 좀 더 짧게 적어주실래요?'

function describeEmptyResponse(finishReason?: string): string {
  if (finishReason === 'length') {
    logger.warn('AI', '빈 응답 감지: finishReason=length (토큰 예산 소진)')
    return LENGTH_CUT_NOTICE
  }
  logger.warn(
    'AI',
    `빈 응답 감지${
      finishReason !== undefined ? `: finishReason=${finishReason}` : ''
    }`
  )
  return EMPTY_RESPONSE_NOTICE
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
  const permissionInfo =
    input.permissionSummary !== undefined
      ? `(권한: ${input.permissionSummary})`
      : input.isOwner
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
  const generateOptions = {
    tools: input.tools,
    imageUrls: input.imageUrls,
    maxSteps: 20,
    systemPrompt: promptParts.length > 1 ? promptParts.join('\n\n') : undefined,
  }

  // 스트리밍 포트가 있으면 스트리밍 경로를, 없으면 기존 generate 경로를 쓴다.
  // 스트리밍이 예기치 않게 죽으면 같은 화면(thinking 메시지)에 generate 결과를
  // 확정 편집하므로 새 메시지가 생기지 않는다.
  const stream = input.openStream
  let result: StreamResult

  if (stream === undefined) {
    result = {
      ...(await provider.generate(contextMessage, history, generateOptions)),
      reasoning: '',
      finishReason: undefined,
    }
  } else {
    try {
      result = await provider.stream(contextMessage, history, generateOptions, {
        onReasoning: stream.appendReasoning,
        onText: stream.appendText,
        onToolCall: stream.noteToolCall,
        onProviderSwitch: stream.noteProviderSwitch,
      })
    } catch (error) {
      logger.warn(
        'AI',
        `답장 스트리밍 실패(${
          error instanceof Error ? error.message : String(error)
        }) — generate 경로로 폴백`
      )
      result = {
        ...(await provider.generate(contextMessage, history, generateOptions)),
        reasoning: '',
        finishReason: undefined,
      }
    }
  }

  const cleaned = stripToolCallSyntax(stripThinkTags(result.text))
  appendToSession(sessionKey, { content: cleaned, role: 'assistant' })

  const usedTools =
    result.toolRecords.length > 0
      ? `\n\n> 사용: ${result.toolRecords.map((r) => r.name).join(', ')}`
      : ''
  const response =
    cleaned.trim().length > 0
      ? `${cleaned}${usedTools}\n\n${FOOTER_HINT}`
      : describeEmptyResponse(result.finishReason)

  // 스트리밍 포트가 있으면 최종 확정 편집까지 마친 뒤 id를 받는다.
  // id가 있으면 이미 화면에 답이 있으므로 호출부는 reply()를 보내지 않는다.
  const streamedMessageId =
    stream !== undefined ? await stream.complete(response) : undefined

  return {
    response,
    continuedFromSession: true,
    sessionKey,
    toolRecords: result.toolRecords,
    ...(streamedMessageId !== undefined ? { streamedMessageId } : {}),
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
