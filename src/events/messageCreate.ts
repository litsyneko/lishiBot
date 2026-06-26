import type { ProviderAdapter, ToolDefinitionInput } from '../features/ai/aiPolicy'
import { assertCanUseAiManagement } from '../features/ai/aiPolicy'
import type { AiStage } from '../features/ai/animationMessages'
import { detectMentionPrompt, type IntroInfo, INTRO_INFO } from '../features/ai/mentionAi'
import { stripThinkTags, stripToolCallSyntax } from '../features/ai/thinkStripper'
import { getMemoryStore } from '../features/ai/memoryStore'
import { getHistory } from '../features/ai/conversationStore'
import { KOREAN_SYSTEM_PROMPT } from '../features/ai/systemPrompt'

export type MessageCreateInput = {
  readonly authorBot: boolean
  readonly content: string
  readonly guildId: string
  readonly userId: string
  readonly hasManageGuild: boolean
  readonly isOwner: boolean
  readonly replyToBotMessageId?: string | undefined
  readonly memberDisplayName?: string
  readonly guildName?: string
  readonly channelId: string
  readonly channelName?: string
}

export type MessageCreateAiConfig = {
  readonly botId: string
  readonly provider?: ProviderAdapter | undefined
  readonly tools?: readonly ToolDefinitionInput[]
}

export type MessageReply =
  | { readonly embed: IntroInfo; readonly type: 'embed' }
  | { readonly content: string; readonly type: 'text' }

export type MessageCreateContext = {
  readonly ai: MessageCreateAiConfig
  readonly editStage?: (stage: AiStage) => void
  readonly message: MessageCreateInput
  readonly reply: (reply: MessageReply) => void
  readonly sendStage?: (stage: AiStage) => void
  readonly triggerTyping?: () => void
}

export type MessageCreateResult = {
  readonly handled: boolean
  readonly sessionContinued: boolean
  readonly sessionKey?: string
  readonly enrichedPrompt?: string
  readonly aiText?: string
  readonly toolRecords?: readonly { name: string; args: Record<string, unknown>; result: unknown; success: boolean }[]
}

const FOOTER_HINT = '---\n\n-# 이 메시지에 답장하면 대화를 이어갈 수 있어요.'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runThinkingAnimation(
  sendStage: (stage: AiStage) => void | Promise<void>,
  editStage: (stage: AiStage) => void | Promise<void>,
  triggerTyping?: () => void,
  totalMs = 2500,
): Promise<void> {
  const stage1ms = 800
  const stage2ms = 800
  const stage3ms = Math.max(0, totalMs - stage1ms - stage2ms)

  triggerTyping?.()
  await sendStage('permission')
  await sleep(stage1ms)

  triggerTyping?.()
  await editStage('understanding')
  await sleep(stage2ms)

  triggerTyping?.()
  await editStage('generating')
  await sleep(stage3ms)
}

export async function handleMessageCreate(
  context: MessageCreateContext,
): Promise<MessageCreateResult> {
  if (context.message.authorBot) {
    return { handled: false, sessionContinued: false }
  }

  try {
    const mentionInfo = detectMentionPrompt(context.ai.botId, context.message.content)
    if (mentionInfo === undefined) {
      return { handled: false, sessionContinued: false }
    }

    if (mentionInfo.prompt.trim().length === 0) {
      context.reply({ embed: INTRO_INFO, type: 'embed' })
      return { handled: true, sessionContinued: false }
    }

    assertCanUseAiManagement({
      administrator: context.message.isOwner || context.message.hasManageGuild,
      manageGuild: context.message.hasManageGuild,
    })

    if (context.ai.provider === undefined) {
      context.reply({
        content: 'AI 응답이 준비됐어요: dry-run 모드라 실제 작업은 수행하지 않아요.',
        type: 'text',
      })
      return { handled: true, sessionContinued: false }
    }

    const thinkPromise =
      context.sendStage !== undefined && context.editStage !== undefined
        ? runThinkingAnimation(context.sendStage, context.editStage, context.triggerTyping, 2500)
        : sleep(2500)

    const displayName = context.message.memberDisplayName ?? '사용자'
    const guildName = context.message.guildName ?? '서버'
    const channelName = context.message.channelName ?? '현재 채널'
    const permissionInfo = context.message.isOwner
      ? '(권한: 서버 주인)'
      : context.message.hasManageGuild
        ? '(권한: 서버 관리자)'
        : '(권한: 일반 유저)'
    const sessionKey = `${context.message.guildId}:${context.message.userId}`
    const memoryBlock = await getMemoryStore().formatForPrompt(context.message.userId)
    const personalityBlock = await getMemoryStore().buildPersonalityPrompt(context.message.userId)
    const contextHeader =
      `[대화 시작 - 사용자: ${displayName}] ${permissionInfo} (서버: ${guildName}, 채널: #${channelName})\n\n${mentionInfo.prompt}`
    const enrichedPrompt = memoryBlock + contextHeader

    const existingHistory = getHistory(sessionKey)
    const aiPromise = context.ai.provider.generate(enrichedPrompt, existingHistory, {
      tools: context.ai.tools,
      maxSteps: 20,
      systemPrompt: personalityBlock.length > 0 ? `${KOREAN_SYSTEM_PROMPT}\n\n${personalityBlock}` : undefined,
    })

    const [response] = await Promise.all([aiPromise, thinkPromise])

    const cleaned = stripToolCallSyntax(stripThinkTags(response.text))
    const usedTools = response.toolRecords.length > 0
      ? `\n\n> 사용: ${response.toolRecords.map((r) => r.name).join(', ')}`
      : ''
    context.reply({ content: `${cleaned}${usedTools}\n\n${FOOTER_HINT}`, type: 'text' })

    return {
      handled: true,
      sessionContinued: false,
      sessionKey,
      enrichedPrompt: contextHeader,
      aiText: cleaned,
      toolRecords: response.toolRecords,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI 처리 중 문제가 생겼어요.'
    context.reply({ content: message, type: 'text' })
    return { handled: true, sessionContinued: false }
  }
}
