/**
 * Discord 메시지 하나를 소유하고 AI 스트리밍 델타로 갱신하는 렌더러.
 *
 * 조판 규칙 (요구사항):
 * - thinking(추론)은 평문 인용줄(>)로 노출한다. 코드블록도 spoiler도 아니다.
 * - 인용 누적은 최근 N줄로 잘라 Discord 2000자 상한에 안전하게 맞춘다.
 * - 줄바꿈이 없는 긴 생각도 최소 편집 간격에 맞춰 갱신한다.
 *   Discord rate limit을 피하기 위해 편집 간격을 둔다.
 * - 스트리밍이 끝나면 마지막 본문을 반드시 1회 편집해 최종 상태를 확정한다.
 *
 * 실패 absorb 규칙:
 * - 429: 조용히 무시하고 최소간격만큼 더 기다린 뒤 다시 시도한다.
 * - 메시지 삭제(10008/404/40003): 더 이상 편집하지 않는다(플래그).
 * - 그 외 오류: 한 번만 경고 남기고 다음 갱신을 계속 시도한다.
 * 모든 진입점은 예외를 밖으로 던지지 않으며 complete()는 반드시 settle 된다.
 */
import { logger } from '../../utils/logger'
import type { AiStreamOutput } from './aiPolicy'

const TRUNCATION_NOTICE = '… (내용이 잘렸어요)'
const MAX_REASONING_LINES = 12
const REASONING_SEPARATOR = '\n\n---\n\n'
const DEFAULT_MIN_EDIT_INTERVAL_MS = 1500
const TYPING_KEEPALIVE_MS = 9000
const RATE_LIMIT_BACKOFF_MS = 2000

const THINKING_PLACEHOLDER = '_💭 생각하는 중이에요…_'
const TOOL_PLACEHOLDER = '🔧 `%s` 도구를 쓰는 중이에요…'
const PROVIDER_SWITCH_PLACEHOLDER =
  '🔄 `%s` 님에게 이어서 물어보며 생각하는 중이에요…'
const EMPTY_RESPONSE_NOTICE =
  '_💭 모델이 대답을 끝내지 못했어요. 조금 뒤에 다시 물어봐 주세요._'

/** Discord에서 한 메시지가 담을 수 있는 본문 길이 상한. */
const MESSAGE_LENGTH_LIMIT = 2000

type MessageLike = {
  readonly id: string
  readonly edit: (content: string) => Promise<unknown>
}

export type StreamMessageHost = {
  /** 스트리밍 메시지를 띄우고 갱신할 수 있는 핸들을 돌려준다. */
  readonly send: (content: string) => Promise<MessageLike>
  readonly setTyping?: () => void
}

export type StreamRendererConfig = {
  readonly host: StreamMessageHost
  // 마지막 편집 후 다음 편집까지의 최소 간격(ms). 기본 1500ms.
  readonly minEditIntervalMs?: number
  // 첫 내용을 띄운 순간 호출된다. 단계 애니메이션 취소 같은 후처리에 쓴다.
  readonly onFirstContent?: () => void
}

/** 평문 인용으로 쌓을 thinking 누적본. 최근 N줄만 유지한다. */
function renderReasoningQuote(reasoning: string): string {
  const lines = reasoning
    .replace(/\r\n?/gu, '\n')
    .replace(/&#(?:x20|32);|&nbsp;/giu, ' ')
    .split('\n')
    .map((line) => line.trimEnd())

  // 선행 공백만 제거하고 문단 사이의 빈 줄은 인용 안에 남긴다.
  while (lines.length > 0 && lines[0].trim().length === 0) lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0)
    lines.pop()
  if (lines.length === 0) return ''

  const recent = lines.slice(-MAX_REASONING_LINES)
  const dropped = lines.length - recent.length
  const header =
    dropped > 0 ? `_최근 생각 ${MAX_REASONING_LINES}줄만 보여드려요._\n` : ''
  const quoted = recent
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n')
  return `${header}${quoted}`
}

/** 상한을 넘으면 뒤에서부터 자른다 — 최신 내용이 살아남도록. */
function clampToLimit(content: string): string {
  if (content.length <= MESSAGE_LENGTH_LIMIT) {
    return content
  }
  // 잘림 안내 + 구분 줄바꿈까지 상한에 포함한다.
  const keep = MESSAGE_LENGTH_LIMIT - TRUNCATION_NOTICE.length - 1
  return `${TRUNCATION_NOTICE}\n${content.slice(content.length - keep)}`
}

/** thinking 인용 + 구분선 + 본문을 하나의 메시지 본문으로 조판한다 (순수). */
export function composeStreamMessage(input: {
  readonly reasoning: string
  readonly text: string
  readonly toolName?: string
  readonly providerLabel?: string
  readonly finished: boolean
}): string {
  const quote = renderReasoningQuote(input.reasoning)
  const body = buildBody(input)
  const bodyBlock = quote.length > 0 ? `${quote}${REASONING_SEPARATOR}` : ''

  return clampToLimit(`${bodyBlock}${body}`.trim())
}

function buildBody(input: {
  readonly text: string
  readonly toolName?: string
  readonly providerLabel?: string
  readonly finished: boolean
}): string {
  if (input.text.trim().length > 0) {
    return input.text.trimEnd()
  }

  if (input.finished) {
    return EMPTY_RESPONSE_NOTICE
  }
  if (input.providerLabel !== undefined) {
    return PROVIDER_SWITCH_PLACEHOLDER.replace('%s', input.providerLabel)
  }
  if (input.toolName !== undefined) {
    return TOOL_PLACEHOLDER.replace('%s', input.toolName)
  }
  return THINKING_PLACEHOLDER
}

function isRateLimited(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const code = (error as { code?: unknown }).code
  const status = (error as { status?: unknown }).status
  return code === 429 || status === 429
}

/** 메시지가 사라진(삭제됨) 상태면 더 이상 편집을 시도하지 않는다. */
function isMessageGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const code = (error as { code?: unknown }).code
  const status = (error as { status?: unknown }).status
  return code === 10008 || status === 404 || code === 40003 || status === 40003
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createStreamRenderer(
  config: StreamRendererConfig
): AiStreamOutput {
  const minEditIntervalMs =
    config.minEditIntervalMs ?? DEFAULT_MIN_EDIT_INTERVAL_MS
  const host = config.host

  let reasoningBuffer = ''
  let textBuffer = ''
  let toolName: string | undefined
  let providerLabel: string | undefined
  let message: MessageLike | undefined
  let lastEditAt = 0
  let hasShownContent = false
  let finished = false
  let messageGone = false
  let typingTimer: ReturnType<typeof setInterval> | undefined
  let trailingEditTimer: ReturnType<typeof setTimeout> | undefined

  const render = (): string =>
    composeStreamMessage({
      reasoning: reasoningBuffer,
      text: textBuffer,
      ...(toolName !== undefined ? { toolName } : {}),
      ...(providerLabel !== undefined ? { providerLabel } : {}),
      finished,
    })

  function stopTyping(): void {
    if (typingTimer === undefined) {
      return
    }
    clearInterval(typingTimer)
    typingTimer = undefined
  }

  function startTyping(): void {
    if (typingTimer !== undefined) {
      return
    }
    host.setTyping?.()
    typingTimer = setInterval(() => host.setTyping?.(), TYPING_KEEPALIVE_MS)
  }

  function notifyFirstContent(): void {
    if (hasShownContent) {
      return
    }
    hasShownContent = true
    config.onFirstContent?.()
  }

  // 편집은 반드시 순서대로 나간다. 비동기 fire-and-forget으로 두면
  // (1) 메시지가 두 번 생성되고 (2) 오래된 내용이 나중에 확정 덮어쓸 수 있다.
  // 그래서 모든 편집을 하나의 체인에 이어붙인다. complete()는 이 체인이
  // 끝난 뒤 최종 편집을 수행하므로 순서가 보장되고 미완성 Promise도 남지 않는다.
  let editChain: Promise<void> = Promise.resolve()

  // 편집 실패는 삼킨다. 429면 백오프 후 한 번 더 시도하고, 메시지가
  // 사라졌으면 편집 자체를 포기한다(플래그만 남기고 조용히 종료).
  async function pushOnce(content: string): Promise<void> {
    if (messageGone) {
      return
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (message === undefined) {
          message = await host.send(content)
        } else {
          await message.edit(content)
        }
        notifyFirstContent()
        return
      } catch (error) {
        if (isMessageGone(error)) {
          messageGone = true
          logger.debug('AI', '스트리밍 메시지가 사라져 편집을 중단합니다')
          return
        }
        if (isRateLimited(error) && attempt === 0) {
          logger.debug('AI', '스트리밍 편집이 rate limit에 막혀 재시도합니다')
          await sleep(RATE_LIMIT_BACKOFF_MS)
          continue
        }
        logger.warn(
          'AI',
          `스트리밍 편집 실패: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return
      }
    }
  }

  function push(content: string): Promise<void> {
    editChain = editChain.then(() => pushOnce(content))
    return editChain
  }

  function clearTrailingEdit(): void {
    if (trailingEditTimer !== undefined) {
      clearTimeout(trailingEditTimer)
      trailingEditTimer = undefined
    }
  }

  // 짧게 들어온 reasoning이 스로틀 구간 안에서 끝나더라도 마지막 델타를 표시한다.
  function scheduleTrailingEdit(delayMs: number): void {
    if (trailingEditTimer !== undefined) return
    trailingEditTimer = setTimeout(() => {
      trailingEditTimer = undefined
      if (finished || messageGone) return
      startTyping()
      lastEditAt = Date.now()
      void push(render())
    }, delayMs)
  }

  // 최소간격마다 최신 델타를 보여준다. 줄바꿈이 없는 긴 생각도 진행 상태가 보인다.
  function maybeEdit(): void {
    if (finished || messageGone) {
      return
    }
    const remaining = minEditIntervalMs - (Date.now() - lastEditAt)
    if (remaining > 0) {
      scheduleTrailingEdit(remaining)
      return
    }
    clearTrailingEdit()
    startTyping()
    // 편집이 끝나기 전에 다음 델타가 또 올 수 있다. 슬롯을 먼저 차지해
    // 같은 시각에 편집이 중복 예약되지 않게 한다.
    lastEditAt = Date.now()
    void push(render())
  }

  // 상태 변화(도구 실행, 폴백 전환)는 사용자가 기다리는 신호라 스로틀을
  // 무시하고 즉시 노출한다.
  function announceNow(): void {
    if (finished || messageGone) {
      return
    }
    clearTrailingEdit()
    startTyping()
    lastEditAt = Date.now()
    void push(render())
  }

  function resetBuffers(): void {
    reasoningBuffer = ''
    textBuffer = ''
    toolName = undefined
  }

  return {
    appendReasoning: (delta) => {
      if (delta.length === 0) {
        return
      }
      reasoningBuffer += delta
      maybeEdit()
    },

    appendText: (delta) => {
      if (delta.length === 0) {
        return
      }
      textBuffer += delta
      maybeEdit()
    },

    noteToolCall: (name) => {
      if (messageGone) {
        return
      }
      toolName = name
      announceNow()
    },

    noteProviderSwitch: (label) => {
      if (messageGone) {
        return
      }
      // 폴백 provider의 출력이 이전 provider 절반과 섞이면 안 되므로
      // 이미 노출된 내용을 여기서 버린다.
      resetBuffers()
      providerLabel = label
      announceNow()
    },

    complete: async (finalText) => {
      if (finished) {
        return message?.id
      }
      finished = true
      clearTrailingEdit()
      // 생각은 진행 중에만 보여주고, 최종 편집에는 답변만 남긴다.
      reasoningBuffer = ''
      textBuffer = finalText.trim().length > 0 ? finalText : ''
      toolName = undefined
      providerLabel = undefined

      if (textBuffer.trim().length === 0) {
        logger.warn('AI', '스트리밍 결과 본문이 비어 있어 안내 문구를 보냅니다')
      }

      // 진행 중이던 편집을 모두 끝낸 뒤 최종 본문으로 확정 편집한다.
      // 최소간격 미달이어도 이 1회는 반드시 나간다.
      await editChain
      startTyping()
      await push(render())
      stopTyping()

      if (messageGone) {
        return undefined
      }
      return message?.id
    },
  }
}
