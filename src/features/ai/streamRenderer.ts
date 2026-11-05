/**
 * Discord 메시지 하나를 소유하고 AI 스트리밍 델타로 갱신하는 렌더러.
 *
 * 조판 규칙 (요구사항):
 * - thinking(추론)은 평문 인용줄(>)로 노출한다. 코드블록도 spoiler도 아니다.
 * - thinking은 현재 한 줄만 인용으로 보여준다.
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
import {
  type LoopGuardKind,
  type LoopGuardVerdict,
  classifyLoopGuard,
  describeLoopGuard,
  isLoopGuardBlocking,
  truncateAtLoopStart,
} from './loopGuard'

const TRUNCATION_NOTICE = '… (내용이 잘렸어요)'
const MAX_REASONING_LINE_CHARS = 180
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

/**
 * 루프 가드를 검사하는 최소 누적 문자 수.
 * 델타는 보통 한 번에 1~40자라 매 델타마다 전체 버퍼를 검사하면 문자열 비교가
 * 응답 길이만큼 반복된다. 200자 간격이면 최대 1/200 수준으로 줄고, 루프가
 * 걸릴 때 생기는 지연(<200자)도 사람이 느끼지 못하는 크기다.
 */
const LOOP_SCAN_INTERVAL_CHARS = 200

/**
 * 경과 시간 표기를 갱신하는 최소 간격(ms).
 *
 * 표기 이유: 데드라인이 stall 감지로 바뀌면, 느린 thinking은 정상적으로 오래
 * 걸린다. 그러면 사용자가 유일하게 볼 수 있는 신호가 "아직 thinking 중"뿐이라
 * 진행 중이라는 사실조차 알 수 없다. 경과 시간을 보여주면 '멈춘 것'과
 * '오래 걸리는 것'을 사용자가 스스로 구분할 수 있다.
 *
 * 간격을 두는 이유: 초 단위로 갱신하면 매 편집마다 payload가 바뀌어 편집
 * 요청만 늘고 Discord rate limit에 걸린다. 10초 단위면 체감상 충분히 '살아있다'는
 * 신호가면서 편집 수는 1/10로 줄어든다.
 */
const ELAPSED_LABEL_STEP_MS = 10_000

/**
 * 세션에 남길 사고 요약의 상한(자).
 *
 * 사고는 문법이 반복적이라 전체를 넣으면 컨텍스트 예산(providerCore의
 * contextTokens)을 태운다. 그런데 전부 버리면 'AI가 뭘 오래하고 있었나'를
 * 알 수 없다. 최근 N자만 남겨 정황을 되살리는 절충이다.
 */
const REASONING_SUMMARY_LIMIT = 500

/**
 * 편집이 어느 단계의 것인지. 호출부는 이 값으로 중지 버튼을 붙일지 떼낼지
 * 정한다. 'final'은 complete()의 마지막 확정 편집이다.
 *
 * 왜 이 구분이 필요한가: 스트리밍 델타 편집은 1.5초마다 반복되므로 호출부가
 * 매번 "버튼 없는 payload"로 편집하면 버튼이 생겼다가 1.5초 뒤 사라진다.
 * renderer는 이 단계만 알 수 있으므로, 버튼 수명을 renderer가 판단하고 그
 * 판단을 host.edit에 인자로 넘긴다.
 */
export type StreamEditPhase = 'final' | 'running'

type MessageLike = {
  readonly id: string
  // host.send가 돌려주는 핸들. phase를 무시하는 기존 구현은 그대로 동작한다
  // (인자를 덜 받는 함수는 더 많은 인자를 받는 타입에 assignable).
  readonly edit: (content: string, phase: StreamEditPhase) => Promise<unknown>
  readonly delete?: () => Promise<unknown>
}

export type StreamMessageHost = {
  /** 스트리밍 메시지를 띄우고 갱신할 수 있는 핸들을 돌려준다. */
  readonly send: (
    content: string,
    phase: StreamEditPhase
  ) => Promise<MessageLike>
  readonly setTyping?: () => void
}

export type StreamRendererConfig = {
  readonly host: StreamMessageHost
  // 마지막 편집 후 다음 편집까지의 최소 간격(ms). 기본 1500ms.
  readonly minEditIntervalMs?: number
  // 첫 내용을 띄운 순간 호출된다. 단계 애니메이션 취소 같은 후처리에 쓴다.
  readonly onFirstContent?: () => void
  // 델타가 오는데도 같은 내용이 계속 쌓일 때 호출된다. provider 중단은 호출부가
  // abortSignal로 처리하므로, 이 훅은 '왜' 중단됐는지만 알린다.
  readonly onLoopDetected?: (kind: LoopGuardKind) => void
}

/** 생각은 현재 한 줄만 보여준다. */
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

  const current = lines[lines.length - 1]
  const visible =
    current.length > MAX_REASONING_LINE_CHARS
      ? `…${current.slice(-MAX_REASONING_LINE_CHARS)}`
      : current
  return `> ${visible}`
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

/** 진행 중에는 생각 한 줄, 본문이 시작되면 답변만 표시한다 (순수). */
export function composeStreamMessage(input: {
  readonly reasoning: string
  readonly text: string
  readonly toolName?: string
  readonly providerLabel?: string
  readonly finished: boolean
  /** 진행 중일 때만 붙는 경과 시간 표기. 본문이 있으면 무시된다. */
  readonly elapsedLabel?: string
}): string {
  // 답변 본문이 시작되면 생각은 더 이상 진행 상태가 아니다.
  const quote =
    input.finished ||
    input.text.trim().length > 0 ||
    input.toolName !== undefined ||
    input.providerLabel !== undefined
      ? ''
      : renderReasoningQuote(input.reasoning)
  const body = buildBody(input)
  if (quote.length > 0) return clampToLimit(quote)

  // 경과 시간은 '본문이 없음(진행 중)'일 때만 붙인다. 본문이 이미 떴는데
  // "생각하는 중 (1분 20초)"이 붙으면 화면에 모순이 생기고, 사용자는
  // 답을 받고도 AI가 아직 사고 중인 것으로 오해한다.
  const bodyWithElapsed =
    input.text.trim().length === 0 && input.elapsedLabel !== undefined
      ? `${body} (${input.elapsedLabel})`
      : body

  return clampToLimit(bodyWithElapsed.trim())
}

/**
 * 경과 시간을 사람이 읽는 한국어로. 분은 내림하지 않고 올림해 "0분"이
 * 애매하게 보이지 않게 하고, 1시간 이상은 시간 단위로 바꾼다.
 *
 * 매 편집마다 시간이 바뀌면 같은 문자열이 여러 번 편집되며 rate limit을 탄다.
 * 호출부는 ELAPSED_LABEL_STEP_MS 단위로만 갱신해 이 비용을 막는다.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes === 0) {
    return `${seconds}초`
  }
  const hours = Math.floor(minutes / 60)
  if (hours > 0) {
    return `${hours}시간 ${minutes % 60}분`
  }
  return `${minutes}분 ${seconds}초`
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
  // 화면용 사고는 도구 호출마다 새로 시작한다. 전체 사고는 중단 요약에 남긴다.
  let visibleReasoning = ''
  let textBuffer = ''
  let visibleText = ''
  let toolName: string | undefined
  let providerLabel: string | undefined
  let displayPhase: 'thinking' | 'tool' | 'text' | 'provider' = 'thinking'
  let message: MessageLike | undefined
  let lastEditAt = 0
  let hasShownContent = false
  let finished = false
  let messageGone = false
  let typingTimer: ReturnType<typeof setInterval> | undefined
  let trailingEditTimer: ReturnType<typeof setTimeout> | undefined
  // 루프 가드 판정 결과. undefined가 아니면 반복이 확정됐다는 뜻이므로 이 값
  // 자체가 '차단 여부' 플래그 역할을 한다(boolean을 따로 두지 않는다).
  let loopVerdict: LoopGuardVerdict
  // thinking 버퍼는 본문과 다른 버퍼라 반복 판정도 독립적으로 봐야 한다. 본문이
  // 정상이어도 사고가 루프에 빠질 수 있고, 그 반대도 성립한다. 하나로 공유하면
  // 한쪽의 반복이 다른 쪽 델타까지 막아버린다.
  let reasoningLoopVerdict: LoopGuardVerdict
  // 마지막 검사 이후 누적된 문자 수. LOOP_SCAN_INTERVAL_CHARS에 닿으면 0으로
  // 되돌린다.
  let charsSinceLoopScan = 0
  let reasoningCharsSinceLoopScan = 0
  // 스트리밍 시작 시각. 경과 시간 표기에 쓴다. 첫 델타가 아닌 '메시지가 뜬 시점'
  // 을 기준으로 삼는다 — thinking 화면이 시작된 뒤부터 세는 편이 사용자가
  // 체감하는 시간과 맞기 때문이다.
  let streamStartedAt = Date.now()
  // 마지막으로 표기를 갱신한 시각. ELAPSED_LABEL_STEP_MS 간격으로만 갱신한다.
  let elapsedLabelAt = 0

  const render = (): string => {
    const elapsed = Date.now() - streamStartedAt
    // 간격이 지나면 표기를 갱신하고, 아니면 마지막 표기를 그대로 쓴다.
    if (elapsed - elapsedLabelAt >= ELAPSED_LABEL_STEP_MS) {
      elapsedLabelAt = elapsed
    }
    return composeStreamMessage({
      reasoning: displayPhase === 'thinking' ? visibleReasoning : '',
      text: finished ? textBuffer : displayPhase === 'text' ? visibleText : '',
      ...(displayPhase === 'tool' && toolName !== undefined
        ? { toolName }
        : {}),
      ...(displayPhase === 'provider' && providerLabel !== undefined
        ? { providerLabel }
        : {}),
      finished,
      elapsedLabel: formatElapsed(elapsedLabelAt),
    })
  }

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

  // 편집은 순서대로 보내되, 대기 중인 진행 화면은 최신 것 하나만 남긴다.
  // 네트워크가 느릴 때 모든 스냅샷을 큐에 쌓으면 오래된 생각을 뒤늦게 보여준다.
  let editChain: Promise<void> = Promise.resolve()
  let pendingRunning: string | undefined
  let runningDrainQueued = false

  // 편집 실패는 삼킨다. 429면 백오프 후 한 번 더 시도하고, 메시지가
  // 사라졌으면 편집 자체를 포기한다(플래그만 남기고 조용히 종료).
  async function pushOnce(
    content: string,
    phase: StreamEditPhase
  ): Promise<boolean> {
    if (messageGone) {
      return false
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (message === undefined) {
          message = await host.send(content, phase)
        } else {
          await message.edit(content, phase)
        }
        notifyFirstContent()
        return true
      } catch (error) {
        if (isMessageGone(error)) {
          messageGone = true
          logger.debug('AI', '스트리밍 메시지가 사라져 편집을 중단합니다')
          return false
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
        return false
      }
    }
    return false
  }

  function push(
    content: string,
    phase: StreamEditPhase = 'running'
  ): Promise<boolean> {
    if (phase === 'running') {
      pendingRunning = content
      if (runningDrainQueued) return Promise.resolve(true)
      runningDrainQueued = true
      const operation = editChain.then(async () => {
        let succeeded = true
        while (pendingRunning !== undefined && !finished && !messageGone) {
          const latest = pendingRunning
          pendingRunning = undefined
          succeeded = (await pushOnce(latest, 'running')) && succeeded
        }
        runningDrainQueued = false
        return succeeded
      })
      editChain = operation.then(() => undefined)
      return operation
    }
    const operation = editChain.then(() => pushOnce(content, phase))
    editChain = operation.then(() => undefined)
    return operation
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
    visibleReasoning = ''
    textBuffer = ''
    visibleText = ''
    toolName = undefined
    displayPhase = 'provider'
    // 폴백 전환은 provider가 바뀌어 새 응답이 시작되는 지점이다. 이전 응답에서
    // 걸린 판정을 물려받으면 새 provider의 정상 첫 문장부터 차단되어 사용자에게
    // '응답이 없는 폴백'으로 보인다. 그래서 여기서 반드시 비운다.
    loopVerdict = undefined
    reasoningLoopVerdict = undefined
    charsSinceLoopScan = 0
    reasoningCharsSinceLoopScan = 0
    // 폴백은 사실상 새 턴이므로 경과 시간도 0에서 다시 센다. 안 그러면 3분 넘게
    // 걸린 폴백이 처음부터 "8분째 사고 중"으로 보인다.
    streamStartedAt = Date.now()
    elapsedLabelAt = 0
  }

  return {
    appendReasoning: (delta) => {
      if (finished || delta.length === 0) {
        return
      }
      // thinking이 반복에 빠졌다면 이후 델타를 버린다. 버퍼가 무한정 커지면
      // 인용 조판과 편집 payload가 함께 무너진다.
      if (isLoopGuardBlocking(reasoningLoopVerdict)) {
        return
      }

      reasoningBuffer += delta
      if (displayPhase !== 'thinking') {
        visibleReasoning = ''
        visibleText = ''
        reasoningLoopVerdict = undefined
        reasoningCharsSinceLoopScan = 0
      }
      visibleReasoning += delta
      displayPhase = 'thinking'
      toolName = undefined
      providerLabel = undefined
      reasoningCharsSinceLoopScan += delta.length
      if (reasoningCharsSinceLoopScan < LOOP_SCAN_INTERVAL_CHARS) {
        maybeEdit()
        return
      }
      reasoningCharsSinceLoopScan = 0

      // 본문과 같은 모듈을 쓰되 target='reasoning'으로 판정한다. 사고는 같은
      // 뼈대를 고쳐 쓰는 경향이 있어 더 엄격한 임계값이 자동으로 적용된다
      // (loopGuard.MIN_NORM_LENGTH_BY_TARGET 참고).
      const verdict = classifyLoopGuard(visibleReasoning, 'reasoning')
      if (verdict === undefined) {
        maybeEdit()
        return
      }

      reasoningLoopVerdict = verdict
      if (isLoopGuardBlocking(verdict)) {
        logger.warn('AI', '사고 과정이 반복으로 판단됨 — 이후 사고 델타 차단')
        config.onLoopDetected?.(verdict.kind)
        return
      }
      // overlong: 사고가 길어졌다는 신호일 뿐 루프가 아니다. provider는 계속
      // 돌린다 — 사고는 최종 화면에서 버려지므로 여기서 끊어도 정답은 나오지만,
      // 사고가 길어지는 게 정상인 high effort를 자르면 정답까지 잃는다.
      logger.warn('AI', '사고 과정이 설정 상한을 넘어 이후 델타 계속 수신')
    },

    appendText: (delta) => {
      if (finished || delta.length === 0) {
        return
      }
      // blocking 판정(반복)일 때만 델타를 버린다. 계속 쌓일 위험이 있어
      // 막아야 하기 때문이다. overlong는 provider가 이미 정상적으로 만든 답이므로
      // 여기서 막으면 정상적인 긴 답변이 조용히 사라진다 — 델타를 계속 받는다.
      if (isLoopGuardBlocking(loopVerdict)) {
        return
      }

      textBuffer += delta
      visibleText += delta
      displayPhase = 'text'
      toolName = undefined
      providerLabel = undefined
      charsSinceLoopScan += delta.length
      if (charsSinceLoopScan < LOOP_SCAN_INTERVAL_CHARS) {
        maybeEdit()
        return
      }
      charsSinceLoopScan = 0

      const verdict = classifyLoopGuard(textBuffer)
      if (verdict === undefined) {
        maybeEdit()
        return
      }

      loopVerdict = verdict
      if (isLoopGuardBlocking(verdict)) {
        logger.warn('AI', '스트리밍 응답 반복 감지 — 이후 델타 차단')
        config.onLoopDetected?.(verdict.kind)
        return
      }
      // overlong: 길이만 넘은 정상 응답. provider를 멈추지 않고 끝까지 받는다.
      logger.warn('AI', '스트리밍 응답이 설정 상한을 넘어 이후 델타 계속 수신')
    },

    noteToolCall: (name) => {
      if (finished || messageGone) {
        return
      }
      toolName = name
      visibleReasoning = ''
      visibleText = ''
      reasoningLoopVerdict = undefined
      reasoningCharsSinceLoopScan = 0
      displayPhase = 'tool'
      announceNow()
    },

    noteProviderSwitch: (label) => {
      if (finished || messageGone) {
        return
      }
      // 폴백 provider의 출력이 이전 provider 절반과 섞이면 안 되므로
      // 이미 노출된 내용을 여기서 버린다.
      resetBuffers()
      providerLabel = label
      announceNow()
    },

    complete: async (finalText, forceFinalText = false) => {
      if (finished) {
        return message?.id
      }
      finished = true
      clearTrailingEdit()
      pendingRunning = undefined
      // 사고가 반복으로 잘렸다면, 버리기 전에 운영에 흔적을 남긴다. 사고는 최종
      // 화면에서 사라지므로 여기서 로그하지 않으면 'AI가 또 반복했다'가 세션에
      // 아무 기록도 남지 않고 사라진다.
      if (isLoopGuardBlocking(reasoningLoopVerdict)) {
        logger.warn(
          'AI',
          `사고 과정이 반복으로 잘림 (${reasoningBuffer.length}자 기록됨)`
        )
      }
      // 생각은 진행 중에만 보여주고, 최종 편집에는 답변만 남긴다.
      reasoningBuffer = ''
      visibleReasoning = ''
      // 확정 규칙은 판정 성격에 따라 갈린다.
      // - repetition: finalText(provider 전문)를 버린다. 그 안에 같은 블록이 몇
      //   번 더 복제돼 있어 그대로 확정하면 사용자에게 반복문이 그대로 보인다.
      //   화면에 이미 보여준 textBuffer를 반복 시작 지점에서 잘라 그 앞부분을
      //   확정하고 안내 문구를 뒤에 붙인다.
      // - overlong  : provider가 끝까지 만든 정상 답변이므로 finalText를 그대로
      //   쓴다. 길이 안내만 덧붙인다. (화면은 2000자 clamp가 이미 방어한다)
      if (!forceFinalText && isLoopGuardBlocking(loopVerdict)) {
        const head = truncateAtLoopStart(textBuffer)
        const notice = describeLoopGuard(loopVerdict)
        textBuffer = head.length > 0 ? `${head}\n\n${notice}` : notice
      } else if (!forceFinalText && loopVerdict !== undefined) {
        const notice = describeLoopGuard(loopVerdict)
        const body = finalText.trim().length > 0 ? finalText : textBuffer
        textBuffer = body.trim().length > 0 ? `${body}\n\n${notice}` : notice
      } else {
        textBuffer = finalText.trim().length > 0 ? finalText : ''
      }
      toolName = undefined
      providerLabel = undefined
      displayPhase = 'text'

      if (textBuffer.trim().length === 0) {
        logger.warn('AI', '스트리밍 결과 본문이 비어 있어 안내 문구를 보냅니다')
      }

      // 진행 중이던 편집을 모두 끝낸 뒤 최종 본문으로 확정 편집한다.
      // 최소간격 미달이어도 이 1회는 반드시 나간다.
      // phase='final' — 이미 끝난 응답에 '중지' 버튼이 남아 있으면 사용자가
      // 눌러 보게 되므로, 이 편집에서 호출부가 버튼을 떼거나 비활성화한다.
      await editChain
      startTyping()
      const finalEditSucceeded = await push(render(), 'final')
      stopTyping()

      if (!finalEditSucceeded) {
        try {
          await message?.delete?.()
        } catch (error) {
          logger.warn(
            'AI',
            `완료 편집 실패 후 진행 메시지 삭제 실패: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
        return undefined
      }
      return message?.id
    },

    takeReasoningSummary: () => {
      // 사고는 정상 종결이면 호출부가 필요로 하지 않는다(답이 있으므로). 그래도
      // 조회만 하는 함수라 부작용이 없고 언제든 읽어도 된다.
      return reasoningBuffer.trim().slice(-REASONING_SUMMARY_LIMIT)
    },

    takeFinalText: () => render(),

    dispose: () => {
      // complete()와 별개로, 어떤 경로로 턴이 끝나도 반드시 호출되어야 하는
      // 명시적 해제다. 멱등이므로 complete()가 이미 정리한 뒤에 다시 불러도
      // 무해하다(typingTimer가 undefined면 stopTyping이 즉시 반환).
      //
      // finished를 먼저 세우는 이유: 큐에 걸린 trailingEditTimer 콜백과
      // pushOnce가 '이미 끝났다'를 보고 스스로 멈추게 되어, dispose 이후에
      // typing이 되살아날 수 없다.
      finished = true
      clearTrailingEdit()
      pendingRunning = undefined
      stopTyping()
    },
  }
}
