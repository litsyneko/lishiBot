import { type AiProviderConfig, config } from '../config'
import { CommandAccessError } from '../domain/errors'
import { handleMessageCreate } from '../events/messageCreate'
import {
  AGENT_CFG_ACTIONS,
  AGENT_CFG_MODAL_PREFIX,
  AGENT_CFG_PREFIX,
  type AgentPanelData,
  DANGER_GATE_LABELS,
  buildAgentSettingsPanel,
  buildConceptModal,
  buildOrderAddModal,
  buildRoleModal,
  buildSoulModal,
} from '../features/ai/agentSettingsPanel'
import type { ProviderAdapter } from '../features/ai/aiPolicy'
import type { ToolDefinitionInput } from '../features/ai/aiPolicy'
import { createAiProviderChain } from '../features/ai/aiProviderChain'
import {
  type AiStage,
  formatStageMessage,
} from '../features/ai/animationMessages'
import { createAnthropicProvider } from '../features/ai/anthropicProvider'
import {
  type ApprovalProposal,
  type ProposalCollector,
  createProposalCollector,
} from '../features/ai/approvalGate'
import { getCommandCatalog } from '../features/ai/commandCatalog'
import {
  SESSION_TTL_MS,
  appendToSession,
  appendToToolHistory,
  clearSessionsForChannel,
  clearUserSession,
  getActiveSessionsCount,
  getOrCreateSession,
  getSessionByMessage,
  getUserSessionInfo,
  isExpired,
  loadAiSessions,
} from '../features/ai/conversationStore'
import {
  type DamagedResponse,
  describeDamagedResponse,
} from '../features/ai/damagedResponse'
import {
  classifyLoopGuard,
  truncateAtLoopStart,
} from '../features/ai/loopGuard'
import { detectMentionPrompt } from '../features/ai/mentionAi'
import { getMessageImageUrls } from '../features/ai/messageImages'
import {
  dismissOnboarding,
  shouldShowOnboarding,
} from '../features/ai/onboarding'
import {
  buildOnboardingCard,
  buildOnboardingResolvedCard,
  parseOnboardingCustomId,
} from '../features/ai/onboardingCard'
import { createOpencodeZenProvider } from '../features/ai/opencodeZenProvider'
import { summarizeMemberPermissions } from '../features/ai/permissionSummary'
import {
  checkLiveToolPermission,
  checkToolPermissionLayer3,
} from '../features/ai/permissions/permissionCheck'
import { AiTurnAbortedError } from '../features/ai/providerErrors'
import { getRecentMessagesForPrompt } from '../features/ai/recentMessages'
import {
  APPROVAL_TIMEOUT_OPTIONS,
  getServerProfile,
  getSoul,
  getStandingOrders,
  setSoul,
  setStandingOrders,
  upsertServerProfile,
} from '../features/ai/serverProfile'
import { handleSessionReply } from '../features/ai/sessionReply'
import { attachStopButton, parseStopCustomId } from '../features/ai/stopButton'
import { createStreamRenderer } from '../features/ai/streamRenderer'
import { toAiFinalMessage } from '../features/ai/tableImage'
import { stripThinkTags, toComponentV2 } from '../features/ai/thinkStripper'
import { roleAssignmentIsSensitive } from '../features/ai/tools/helpers/roleRisk'
import { delayBeforeToolCall } from '../features/ai/tools/helpers/toolDelay'
import {
  buildApprovalCard,
  buildResolvedApprovalCard,
  parseApprovalCustomId,
} from '../features/ai/tools/proposalCard'
import { createToolRegistry } from '../features/ai/tools/toolRegistry'
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistry,
} from '../features/ai/tools/toolTypes'
import {
  type ActiveTurn,
  acquireSessionTurn,
  beginTurn,
  endTurn,
  getTurn,
} from '../features/ai/turnRegistry'
import { logger } from '../utils/logger'
import { requireServerManager } from '../utils/permissions'
import { replyEphemeral } from '../utils/replies'
import { Extension, SubCommandGroup, listener } from '@pikokr/command.ts'
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  type Message,
  type MessageComponentInteraction,
  type MessageCreateOptions,
  MessageFlags,
  MessageReferenceType,
  type ModalMessageModalSubmitInteraction,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
} from 'discord.js'

// zai-proxy가 가끔 무응답/일시 오류를 내므로 HTTP 요청 단위로 5회까지
// 시도하고, 전부 실패하면 체인이 폴백(gemma4)으로 강등한다. 타임아웃이
// 있어야 "응답이 아예 안 오는" hang도 실패로 집계돼 재시도가 돈다.
const PRIMARY_MAX_ATTEMPTS = 5
const PRIMARY_REQUEST_TIMEOUT_MS = 60_000
// primary 요청의 첫 바이트 상한. 턴 감시(FIRST_ACTIVITY_TIMEOUT_MS 45초)보다
// 짧아야 감시가 턴을 자르기 전에 요청 단위 재시도 1회가 들어간다.
const PRIMARY_FIRST_BYTE_TIMEOUT_MS = 30_000
// 로컬 gemma4는 CPU 추론(~1.5 tok/s)이라 정상 응답도 수 분 걸릴 수 있어
// 타임아웃을 넉넉히 주고, 재시도는 2회만.
const FALLBACK_MAX_ATTEMPTS = 2
const FALLBACK_REQUEST_TIMEOUT_MS = 600_000

/**
 * 반복 감지 후 provider를 멈추기까지의 유예. 이 시간 동안 complete()가 최종
 * 편집을 마쳐 살릴 앞부분을 화면에 확정한다.
 *
 * 렌더러 편집 최소간격(1.5초)보다 짧게 잡았다. 확정 편집이 끝날 시간을 주면서도
 * runaway 생성을 크게 줄인다 — 유예가 길수록 provider가 불필요한 토큰을 더 태운다.
 * 본문 반복과 사고 반복 양쪽이 같은 유예를 재사용한다.
 */
const LOOP_STOP_GRACE_MS = 500

/**
 * 첫 활동까지의 상한(90초). "응답이 아예 안 오는 hang"만 잡는다.
 *
 * 90초로 잡은 이유: 미쿠다요처럼 여러 봇이 공유하는 게이트웨이는 한가할 때는
 * 1초 안에 첫 바이트가 오지만, 바쁠 때는 큐에서 30~90초씩 기다려야 한다.
 * resilientFetch의 첫 바이트 감시(30초)가 hang 시도를 자르고 재시도 1회분의
 * 여유를 주려면 턴 감시는 그보다 길어야 한다 — 90초면 hang이 연달아 와도
 * 재시도 2회까지는 턴이 살아남는다. 그 뒤로는 stall 기준이 알아서 이어진다.
 */
const FIRST_ACTIVITY_TIMEOUT_MS = 90_000

/**
 * 무진행(stall) 상한(60초). 마지막 활동 이후 이 시간 동안 아무 진행도 없으면
 * 중단한다.
 *
 * 활동은 본문 델타·사고 델타·도구 호출을 모두 포함한다. 사고가 3분짜리
 * 러너웨이여도 매초 델타가 오면 '진행 중'이므로 이 타이머는 울리지 않는다
 * (러너웨이 자체는 루프 가드가 잡는다).
 */
const STALL_TIMEOUT_MS = 60_000

/**
 * 하드 상한(절대 시간 10분). 무한 대기를 막는 마지막 안전망.
 *
 * 왜 필요한가: stall은 '느림'을 못 잡는다. thinking이 극도로 느린 모델이라면
 * 매초 델타가 오므로 stall이 영영 울리지 않고 턴이 영영 끝나지 않는다. 채널에
 * typing이 9초마다 계속 뜨고 bot이 응답을 먹으므로, 아무리 느려도 이 시간은
 * 넘기지 않는다. 10분은 gemma4(CPU 추론) 기준 정상 응답 최악치에 여유를 둔 값이다.
 */
const TURN_HARD_LIMIT_MS = 600_000

/**
 * 턴 하나를 처음부터 끝까지 감싼다. 세 개의 시간 상한으로 턴을 지키고, 어떤
 * 경로로 끝나든(정상·중단·예외) 타이머를 내리고 레지스트리에서 턴을 제거한다.
 *
 * 왜 절대 시간 120초 데드라인을 버렸나: 실사용에서 'AI가 생각 태그를 포함해
 * 응답하는데 오래 걸리다가 2분에 잘렸다'는 보고가 왔다. reasongEffort가 high면
 * 사고가 정상적으로 몇 분씩 걸리는데, 절대 시간은 그런 **느리지만 진행 중인**
 * thinking을 hang과 구분하지 못하고 그대로 베었다. 정지 버튼이 이미 있으므로
 * 사용자는 직접 멈출 수 있고, 봇이 대신 자를 이유는 '아무 신호가 없는 경우'뿐이다.
 *
 * 세 상한의 역할 분담:
 * - FIRST_ACTIVITY_TIMEOUT_MS: 응답이 아예 안 오는 hang. 첫 신호 전만 적용된다.
 * - STALL_TIMEOUT_MS: 무진행. 매 활동마다 리셋되어, 활동이 이어지는 한 울리지
 *   않는다. hang이 '첫 신호를 못 내고 멈추는' 형태여도 여기서 2차로 잡힌다.
 * - TURN_HARD_LIMIT_MS: 절대 시간. stall이 못 잡는 극단적 슬로우의 최종 안전망.
 *
 * 리셋 방식: setTimeout을 지우고 다시 건다. stop()이 멱등이라 다중 발해도 안전하다.
 * activitySignal은 호출부(델타/사고를 흘려주는 지점)에서 '활동이 있었다'는 신호만
 * 보내며, 구체적인 무엇을 했는지는 모른다.
 */
async function runTurn<T>(
  turn: ActiveTurn,
  extraTimers: Set<ReturnType<typeof setTimeout>>,
  task: (onActivity: () => void) => Promise<T>
): Promise<T> {
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  let hardTimer: ReturnType<typeof setTimeout> | undefined
  let hasActivity = false

  // 활동이 있었을 때만 호출된다. 첫 활동 전에는 첫 신호 상한(FIRST_ACTIVITY_TIMEOUT_MS)을,
  // 그 뒤에는 stall 상한(STALL_TIMEOUT_MS)을 건다 — '신호가 아예 없음'과
  // '진행은 하는데 멈춤'이 같은 창을 쓰면 안 되기 때문이다.
  const onActivity = (): void => {
    hasActivity = true
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer)
    }
    stallTimer = setTimeout(() => {
      logger.warn('AI', `턴 무진행 ${STALL_TIMEOUT_MS}ms 초과: ${turn.turnId}`)
      turn.stop('deadline')
    }, STALL_TIMEOUT_MS)
  }

  stallTimer = setTimeout(() => {
    logger.warn(
      'AI',
      `턴 첫 활동 ${FIRST_ACTIVITY_TIMEOUT_MS}ms 초과 (응답 없음): ${turn.turnId}`
    )
    turn.stop('deadline')
  }, FIRST_ACTIVITY_TIMEOUT_MS)

  hardTimer = setTimeout(() => {
    logger.warn(
      'AI',
      `턴 하드 상한 ${TURN_HARD_LIMIT_MS}ms 초과: ${turn.turnId}`
    )
    turn.stop('deadline')
  }, TURN_HARD_LIMIT_MS)

  const clearGuards = (): void => {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer)
      stallTimer = undefined
    }
    if (hardTimer !== undefined) {
      clearTimeout(hardTimer)
      hardTimer = undefined
    }
  }

  try {
    return await task(onActivity)
  } finally {
    clearGuards()
    if (!hasActivity) {
      // 활동 없이 끝난 경우(빈 응답 등)는 오해를 줄이려고 기록한다. 이 값은
      // 방어적 분기라 정상 경로에서 쓰이지 않는다.
      logger.debug('AI', `턴 종료(활동 없음): ${turn.turnId}`)
    }
    for (const timer of extraTimers) {
      clearTimeout(timer)
    }
    extraTimers.clear()
    endTurn(turn.turnId)
  }
}

/**
 * 스트리밍 메시지에 중지 버튼을 붙인 채로 편집한다.
 * phase='final'(확정 편집)이면 버튼을 '중지됨'으로 비활성화한다 — 이미 끝난
 * 응답에 살아 있는 '중지'가 남아 있으면 사용자가 눌러 보게 되기 때문이다.
 */
function editStreamingMessage(
  message: Message,
  messageId: string,
  content: string,
  turnId: string,
  phase: 'final' | 'running'
): Promise<unknown> {
  // reserve는 '지금 붙일 컴포넌트 수'만큼 미리 뺀다.
  // - running: 중지 버튼 행(+1)을 붙이므로 1칸을 뺀다. 여기서 상한을 꽉 채우면
  //   버튼이 붙는 순간 최상위 11개가 되어 Discord가 400을 돌려주고, 그 오류가
  //   결정적이라 편집이 1.5초마다 실패 재시도된다(F8).
  // - final: 버튼을 제거하므로 아무것도 안 붙인다. 따라서 상한을 온전히 쓸 수
  //   있어 reserve=0이다. 끝난 응답은 구분선이 많아도 잘리지 않는다.
  const reserve = phase === 'running' ? 1 : 0
  if (phase === 'final') {
    const payload = toAiFinalMessage(content)
    return message.channel.messages.edit(messageId, payload)
  }
  const v2 = toComponentV2(content, reserve)
  return message.channel.messages.edit(messageId, {
    content: '',
    ...attachStopButton(v2.components, turnId),
  })
}

/**
 * assistant 턴을 세션에 남긴다.
 *
 * 손상된 응답은 원문 대신 마커 문장을 저장한다. 이게 3단계의 핵심이다 —
 * 반복으로 잘린 텍스트를 그대로 남기면 다음 턴의 모델이 그걸 대화 기록으로
 * 읽고 같은 패턴을 이어서 반복한다. 감지는 1단계에서 붙였지만 저장을 막지
 * 않으면 증폭은 그대로라, 감지와 저장을 여기서 한 쌍으로 묶는다.
 *
 * 반복(kind='loop-guard')에는 마커와 함께 **깨끗한 앞부분만** 저장한다.
 * 마커가 "앞부분이 남아 있다"고 말하는데 앞부분이 없으면 모델이 없는 내용을
 * 추측해 지어내고, 그것이 애초 막으려던 재반복의 재료가 된다. 반대로 앞부분이
 * 아직 반복을 담고 있으면 그걸 넣는 순간 증폭이 그대로 되살아난다. 그래서
 * truncateAtLoopStart 결과를 다시 검사해 깨끗할 때만 붙인다.
 *
 * 사고 요약(reasoningSummary)은 마커를 **대신하지 않고 덧붙인다.** 데드라인이나
 * 사용자 중단으로 턴이 끊기면 마커만 남고 'AI가 그동안 뭘 했나'를 알 수 없다.
 * 사고는 최종 화면에서 버려지므로 여기서라도 보존하지 않으면 어디에도 남지
 * 않는다. 최근 500자만(렌더러가 자른다) 붙여 컨텍스트 낭비를 막는다.
 *
 * 로그에는 판정 종류와 길이만 남긴다. 손상 텍스트는 수천 자 반복본일 수 있어
 * 운영 로그를 태우고, 반복 원문 자체를 로그에 다시 남기는 순간 그게 또 다른
 * 오염源이 된다. "왜 이 턴이 marker로 저장됐는지"만 알 수 있으면 충분하다.
 */
function recordAssistantTurn(
  sessionKey: string,
  content: string,
  damaged: DamagedResponse,
  messageId: string,
  reasoningSummary = ''
): void {
  if (damaged === undefined) {
    appendToSession(sessionKey, { content, role: 'assistant' }, messageId)
    return
  }

  if (damaged.kind === 'loop-guard') {
    // truncateAtLoopStart는 '마지막 3회 반복'만 잘라낸다. 루프가 앞에서부터
    // 시작했으면 앞부분에 같은 반복이 그대로 남아 있다(16회 반복 → head에 13회
    // 잔존). 그런 head를 세션에 넣으면 막으려던 재반복이 그대로 되살아난다.
    // 그래서 head를 다시 검사해 **깨끗할 때만** 함께 저장한다.
    const head = truncateAtLoopStart(content)
    const isHeadClean = head.length > 0 && classifyLoopGuard(head) === undefined
    const marker = describeDamagedResponse(damaged)
    logger.info(
      'AI',
      isHeadClean
        ? `손상된 응답을 마커+앞부분으로 세션 저장: kind=${damaged.kind} (원문 ${content.length}자 → 앞부분 ${head.length}자)`
        : `손상된 응답을 마커로만 세션 저장: kind=${damaged.kind} (원문 ${content.length}자, 앞부분도 반복이라 제외)`
    )
    appendToSession(
      sessionKey,
      {
        content: `${marker}${isHeadClean ? `\n\n${head}` : ''}${reasoningBlock(
          reasoningSummary
        )}`,
        role: 'assistant',
      },
      messageId
    )
    return
  }

  logger.info(
    'AI',
    `손상된 응답을 세션에 원문 대신 마커로 저장: kind=${damaged.kind} (원문 ${content.length}자 제외)`
  )
  appendToSession(
    sessionKey,
    {
      content: `${describeDamagedResponse(damaged)}${reasoningBlock(
        reasoningSummary
      )}`,
      role: 'assistant',
    },
    messageId
  )
}

/**
 * 세션에 붙일 사고 요약 블록. 사고가 없으면 빈 문자열이라 아무것도 안 붙는다.
 *
 * 문구에 '답이 아니라 중단 시점까지의 사고'라고 명시하는 이유: 다음 턴의 모델이
 * 이 블록을 자기 답변의 일부로 읽으면 사고 문장을 다시 풀어 쓰기 시작한다.
 * 괄호로 '기록'임을 표시해 정답이 아님을 분명히 한다.
 */
function reasoningBlock(reasoningSummary: string): string {
  if (reasoningSummary.trim().length === 0) {
    return ''
  }
  return `\n\n(답을 마치지 못한 시점까지의 생각이에요. 참고만 하세요.)\n${reasoningSummary.trim()}`
}

function buildProvider(): ProviderAdapter | undefined {
  const aiConfig = config.ai
  const primaryConfig = aiConfig.primary
  if (primaryConfig === undefined) {
    logger.warn('AI', 'AI provider가 비활성화됨 (dry-run 모드)')
    return undefined
  }

  try {
    const primary = createProviderAdapter(primaryConfig, 'primary')
    const fallbackConfigs = aiConfig.fallbacks ?? []
    const fallbacks: ProviderAdapter[] = []
    const validFallbackDescs: string[] = []

    for (const cfg of fallbackConfigs) {
      try {
        fallbacks.push(createProviderAdapter(cfg, 'fallback'))
        validFallbackDescs.push(describeProvider(cfg))
      } catch (fbErr) {
        logger.warn(
          'AI',
          `폴백 provider(${describeProvider(cfg)}) 초기화 실패, 건너뜁니다: ${
            fbErr instanceof Error ? fbErr.message : String(fbErr)
          }`
        )
      }
    }

    logger.info(
      'AI',
      `AI 두뇌 구성 완료 (primary=${describeProvider(primaryConfig)}${
        validFallbackDescs.length > 0
          ? `, fallbacks=[${validFallbackDescs.join(', ')}]`
          : ''
      }) · 컨텍스트 예산: ${
        config.ai.contextTokens !== undefined
          ? `${config.ai.contextTokens} (config 설정값)`
          : `자동 (primary=${resolveContextTokens(primaryConfig)})`
      }`
    )
    // 체인으로 감싸 primary→fallbacks 순서→dry-run 사과 순으로 우아하게 강등.
    return createAiProviderChain({ primary, fallbacks })
  } catch (error) {
    logger.warn(
      'AI',
      `AI provider 구성 실패 — dry-run 모드로 강등 (${
        error instanceof Error ? error.message : String(error)
      })`
    )
    return undefined
  }
}

function describeProvider(cfg: AiProviderConfig): string {
  const name = cfg.label ?? cfg.provider
  return cfg.baseUrl !== undefined ? `${name}@${cfg.baseUrl}` : name
}

const LOCAL_CONTEXT_TOKENS = 131072 // 128k — 로컬 엔드포인트 기본 컨텍스트 예산
const CLOUD_CONTEXT_TOKENS = 1048576 // 1m — 클라우드 엔드포인트 기본 컨텍스트 예산

// 로컬 추론 모델(gemma4·qwen 등)은 높은 온도에서 도구 호출 인자와 JSON
// 형태가 흔들린다. 잡무용 로컬 두뇌에는 낮은 온도가 안정적이므로 0.2로 고정.
const LOCAL_TEMPERATURE = 0.2

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

function isLocalEndpoint(baseUrl?: string): boolean {
  if (baseUrl === undefined) return false // 미지정 시 OpenCode Zen = 클라우드
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (LOCAL_HOSTNAMES.has(host)) return true
    // 사설 IPv4 대역(10.x / 192.168.x / 172.16-31.x)도 로컬로 본다.
    const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
    if (match === null) return false
    const first = Number(match[1])
    const second = Number(match[2])
    if (first === 10) return true
    if (first === 192 && second === 168) return true
    return first === 172 && second >= 16 && second <= 31
  } catch {
    return false
  }
}

// 프로바이더 자체 값 → 전역 config.ai.contextTokens → 엔드포인트 자동 감지 순.
function resolveContextTokens(cfg: AiProviderConfig): number {
  return (
    cfg.contextTokens ??
    config.ai.contextTokens ??
    (isLocalEndpoint(cfg.baseUrl) ? LOCAL_CONTEXT_TOKENS : CLOUD_CONTEXT_TOKENS)
  )
}

// config에 temperature가 있으면 그 값, 없으면 로컬 엔드포인트만 0.2.
// 클라우드는 undefined를 돌려줘 SDK/엔드포인트 기본값에 맡긴다.
function resolveTemperature(cfg: AiProviderConfig): number | undefined {
  return (
    cfg.temperature ??
    (isLocalEndpoint(cfg.baseUrl) ? LOCAL_TEMPERATURE : undefined)
  )
}

function createProviderAdapter(
  cfg: AiProviderConfig,
  role: 'primary' | 'fallback'
): ProviderAdapter {
  switch (cfg.provider) {
    case 'anthropic': {
      if (cfg.apiKey === undefined || cfg.apiKey.trim().length === 0) {
        throw new Error(
          `anthropic provider에는 apiKey가 필요합니다 (model=${cfg.model})`
        )
      }
      return createAnthropicProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        contextTokens: resolveContextTokens(cfg),
        supportsImages: cfg.supportsImages,
      })
    }
    case 'openai-compatible':
      return createOpencodeZenProvider({
        apiKey: cfg.apiKey ?? '',
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        label: cfg.label ?? cfg.model,
        reasoningEffort: cfg.reasoningEffort,
        temperature: resolveTemperature(cfg),
        contextTokens: resolveContextTokens(cfg),
        supportsImages: cfg.supportsImages,
        maxAttempts:
          role === 'primary' ? PRIMARY_MAX_ATTEMPTS : FALLBACK_MAX_ATTEMPTS,
        requestTimeoutMs:
          role === 'primary'
            ? PRIMARY_REQUEST_TIMEOUT_MS
            : FALLBACK_REQUEST_TIMEOUT_MS,
        // 첫 바이트 상한은 primary에만 건다. 턴 감시(FIRST_ACTIVITY_TIMEOUT_MS
        // 45초)가 턴을 통째로 자르기 전에 요청 단위에서 hang을 잡아 재시도하려면
        // 턴 감시보다 짧아야 한다 — 30초면 감시 45초 안에 재시도 1회가 들어간다.
        firstByteTimeoutMs:
          role === 'primary' ? PRIMARY_FIRST_BYTE_TIMEOUT_MS : undefined,
      })
    default:
      throw new Error(
        `지원하지 않거나 누락된 provider입니다: ${String(
          (cfg as { provider?: unknown }).provider
        )}`
      )
  }
}

const agentGroup = new SubCommandGroup({
  name: '에이전트',
  description: 'AI 에이전트 상태 확인 및 서버별 설정 관리',
})

const MAX_STANDING_ORDERS = 10

class AiMentionExtensionClass extends Extension {
  private provider: ProviderAdapter | undefined
  private toolRegistry: ToolRegistry | undefined
  // 승인 대기 중인 위험 도구 제안 (proposalId → 제안). 버튼 인터랙션이 소비한다.
  private pendingApprovals = new Map<
    string,
    ApprovalProposal & {
      cardMessage: Message
      expiresAt: number
      timer: ReturnType<typeof setTimeout>
      dangerGate: 'admin_only' | 'requester' | 'none'
    }
  >()
  // `/에이전트 셋업` 패널별 채널 선택 (패널 메시지 ID → 채널 ID)
  private panelSelectedChannel = new Map<string, string | null>()

  private buildToolDefinitions(
    context: ToolExecutionContext,
    hasManageGuild: boolean,
    hasAdmin: boolean,
    hasManageChannels: boolean,
    collector: ProposalCollector,
    signal: AbortSignal
  ): ToolDefinitionInput[] {
    if (this.toolRegistry === undefined) return []

    const allTools = this.toolRegistry.getAll()
    const result: ToolDefinitionInput[] = []

    for (const toolDef of allTools) {
      const permCheck = checkToolPermissionLayer3(
        toolDef,
        {},
        context,
        hasManageGuild,
        hasAdmin,
        hasManageChannels
      )
      if (!permCheck.ok) continue

      result.push({
        name: toolDef.declaration.name,
        description: toolDef.declaration.description,
        parameters: toolDef.declaration.parameters,
        execute: async (args: Record<string, unknown>) => {
          const ensureRunning = () => {
            if (signal.aborted) throw new AiTurnAbortedError('external')
          }
          const checkPermission = async () => {
            ensureRunning()
            const current = await checkLiveToolPermission(
              this.client,
              toolDef,
              args,
              context
            )
            ensureRunning()
            return current
          }
          const current = await checkPermission()
          if (!current.ok) return { success: false, message: current.reason }
          // 승인 게이트: danger 도구는 서버 승인 정책(dangerGate)에 따라 처리한다.
          // 프로필 조회 실패 시 getServerProfile이 안전 기본값(admin_only)을 반환하므로
          // 정책을 못 읽어도 게이트가 열리는 방향으로는 절대 무너지지 않는다.
          // 역할 부여/회수는 정적 risk가 아니라 대상 역할 권한으로 위험도를 동적 판정한다
          // (관리 권한 역할=danger, 색깔 역할=warning 즉시 실행).
          const effectiveRisk = await this.resolveEffectiveRisk(
            toolDef,
            args,
            context
          )
          ensureRunning()
          if (effectiveRisk === 'danger') {
            const profile = await getServerProfile(context.guildId)
            ensureRunning()
            if (profile.approvalPolicy.dangerGate !== 'none') {
              const permission = await checkPermission()
              if (!permission.ok)
                return { success: false, message: permission.reason }
              logger.info(
                'TOOL',
                `위험 도구 보류(승인 대기): ${toolDef.declaration.name}`
              )
              return collector.propose(toolDef, args, context)
            }
            logger.info(
              'TOOL',
              `위험 도구 즉시 실행(정책 none): ${toolDef.declaration.name}`
            )
          }
          await delayBeforeToolCall(signal)
          const permission = await checkPermission()
          if (!permission.ok)
            return { success: false, message: permission.reason }
          ensureRunning()
          const result = await toolDef.execute(args, {
            ...context,
            abortSignal: signal,
          })
          return result
        },
      })
    }

    return result
  }

  // 도구의 "실효 위험도"를 결정한다. 대부분은 정적 risk 그대로지만,
  // 역할 부여/회수는 대상 역할의 권한으로 동적 판정한다:
  // 관리 권한(Administrator/ManageGuild/ManageRoles 등) 포함 역할 → danger(승인),
  // 색깔·일반 역할 → 정적 warning(즉시 실행). 판정 불가 시 fail-closed로 danger.
  private async resolveEffectiveRisk(
    toolDef: ToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<'info' | 'warning' | 'danger' | undefined> {
    const name = toolDef.declaration.name
    if (name === 'add_role_member' || name === 'remove_role_member') {
      const sensitive = await roleAssignmentIsSensitive(
        this.client,
        context,
        args
      )
      return sensitive ? 'danger' : toolDef.permission.risk ?? 'warning'
    }
    return toolDef.permission.risk
  }

  @listener({ event: 'clientReady' })
  async ready() {
    this.provider = buildProvider()
    this.toolRegistry = createToolRegistry(this.client)
    await loadAiSessions()
  }

  @listener({ event: 'messageCreate' })
  async messageCreate(message: Message) {
    const botId = this.client.user?.id
    if (botId === undefined) {
      return
    }

    if (message.author.bot) {
      return
    }

    const hasManageGuild =
      message.member?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false
    const isOwner = message.guild?.ownerId === message.author.id

    // 전달(Forward)된 메시지도 reference를 갖지만 답장이 아니다.
    // 답장(Default 타입)만 봇 메시지 이어가기로 처리하고, 전달은 무시한다.
    const reference = message.reference
    if (reference !== null && reference.type !== MessageReferenceType.Default) {
      return
    }

    const referencedMessage = reference?.messageId ?? undefined

    if (referencedMessage !== undefined) {
      const referenced = await message.channel.messages
        .fetch(referencedMessage)
        .catch(() => undefined)
      if (
        referenced?.author.id === botId &&
        Date.now() - referenced.createdTimestamp >= SESSION_TTL_MS
      ) {
        await message.reply(
          '이 답장은 3일이 지난 OLD 메시지예요. 저를 새로 멘션해 대화를 시작해 주세요.'
        )
        return
      }
      const traced = getSessionByMessage(referencedMessage)
      if (
        referenced?.author.id === botId &&
        traced !== undefined &&
        traced.session.guildId === (message.guild?.id ?? '') &&
        traced.session.channelId === message.channel.id
      ) {
        if (isExpired(traced.session)) {
          await message.reply(
            '이 대화는 마지막 활동 후 3일이 지나 OLD 상태예요. 저를 새로 멘션해 주세요.'
          )
          return
        }
        await this.handleReplyToBotMessage(
          message,
          referencedMessage,
          referenced
        )
        return
      }
      if (
        referenced?.author.id === botId &&
        detectMentionPrompt(botId, message.content) === undefined
      ) {
        await message.reply(
          '이 답장의 대화 기록을 찾지 못했어요. 저를 멘션해 새 대화를 시작해 주세요.'
        )
        return
      }
    }

    if (detectMentionPrompt(botId, message.content) === undefined) return

    const guildId = message.guild?.id ?? ''
    const userId = message.author.id
    const releaseSession = acquireSessionTurn(
      `${guildId}:${message.channel.id}:${userId}`
    )
    if (releaseSession === undefined) {
      await message.reply(
        '이 대화의 이전 응답이 아직 진행 중이에요. 끝난 뒤 다시 요청해 주세요.'
      )
      return
    }

    try {
      let stageMessageId: string | undefined
      let botMessageId: string | undefined
      // 스트리밍 메시지 id. attachStop이 '이미 만들어진 메시지'만 편집할 수
      // 있으므로 send가 만들어진 시점에 기억한다.
      let lastBotResponse: string | undefined
      let replyComplete: Promise<void> = Promise.resolve()

      const hasAdmin =
        message.member?.permissions.has(PermissionFlagsBits.Administrator) ??
        false
      const collector = createProposalCollector()
      const mentionContext: ToolExecutionContext = {
        guildId: message.guild?.id ?? '',
        guildName: message.guild?.name ?? '',
        userId: message.author.id,
        channelId: message.channel.id,
      }
      const [commandCatalog, recentMessages] = await Promise.all([
        getCommandCatalog(message.guild),
        getRecentMessagesForPrompt(message),
      ])

      // 턴을 먼저 연다. 중지 버튼이 알아야 할 손잡이(turnId)와, provider까지
      // 내려갈 중단 신호는 여기서 만들어진다. 스트리밍 메시지 id는 턴이 열린 뒤에
      // 정해지므로 beginTurn에는 아직 messageId가 없다 — 중지 인터랙션은
      // 채널/사용자까지 함께 보기로 턴을 특정하므로 문제되지 않는다.
      const turn = beginTurn({
        requesterId: userId,
        guildId,
        channelId: message.channel.id,
      })
      const tools = this.buildToolDefinitions(
        mentionContext,
        hasManageGuild,
        hasAdmin,
        message.member?.permissions.has(PermissionFlagsBits.ManageChannels) ??
          false,
        collector,
        turn.controller.signal
      )
      // 턴과 함께 죽어야 할 부수 타이머들(반복 감지 정지 타이머). runTurn이
      // finally에서 전부 정리한다.
      const loopStopTimers = new Set<ReturnType<typeof setTimeout>>()
      const result = await runTurn(turn, loopStopTimers, (onActivity) =>
        handleMessageCreate({
          approvalPending: () => collector.hasPending(),
          ai: {
            botId,
            provider: this.provider,
            tools,
          },
          abortSignal: turn.controller.signal,
          onActivity,
          message: {
            authorBot: message.author.bot,
            content: message.content,
            imageUrls: getMessageImageUrls(message),
            guildId,
            userId,
            hasManageGuild,
            isOwner,
            permissionSummary: summarizeMemberPermissions(
              message.member?.permissions,
              { isOwner }
            ),
            memberDisplayName:
              message.member?.displayName ?? message.author.displayName,
            guildName: message.guild?.name,
            channelId: message.channel.id,
            channelName: message.channel.isDMBased()
              ? undefined
              : message.channel.name,
            commandCatalog,
            recentMessages,
          },
          sendStage: async (stage: AiStage) => {
            const sent = await message.reply(formatStageMessage(stage))
            stageMessageId = sent.id
          },
          editStage: async (stage: AiStage) => {
            if (stageMessageId !== undefined) {
              try {
                await message.channel.messages.edit(
                  stageMessageId,
                  formatStageMessage(stage)
                )
              } catch (err) {
                // message may have been deleted
              }
            }
          },
          triggerTyping: () => {
            const channel = message.channel
            if (
              'sendTyping' in channel &&
              typeof channel.sendTyping === 'function'
            ) {
              void channel.sendTyping()
            }
          },
          openStream: (hooks) =>
            createStreamRenderer({
              // 본문·사고 양쪽의 반복이 여기로 들어온다(두 버퍼는 서로 독립 판정).
              // 어느 쪽이든 repetition일 때만 멈춘다.
              onLoopDetected: (kind) => {
                if (kind !== 'repetition') {
                  // overlong는 정상 응답이므로 provider를 멈추지 않는다.
                  return
                }
                // 즉시 멈추지 않는 이유는 순서 때문이다: 턴이 끝나면 complete()가
                // 최종 편집을 하고 그때 살릴 앞부분이 화면에 확정되는데, 먼저
                // 멈추면 complete()가 실행될 여유 없이 지나갈 수 있다. 그래서 한
                // 박자 기다린 뒤, 그 사이 턴이 이미 끝났으면 건너뛴다.
                const stopTimer = setTimeout(() => {
                  if (turn.isStopped()) {
                    return
                  }
                  logger.warn('AI', `반복 감지로 턴 정지: turn=${turn.turnId}`)
                  turn.stop('loop-guard')
                }, LOOP_STOP_GRACE_MS)
                // 턴이 끝나면 이 타이머가 그대로 남아 프로세스를 붙잡는다.
                loopStopTimers.add(stopTimer)
              },
              onFirstContent: () => {
                // 스트리밍이 화면을 장악하면 단계 메시지는 불필요해진다.
                hooks.onFirstContent()
                if (stageMessageId !== undefined) {
                  const staleId = stageMessageId
                  void message.channel.messages.delete(staleId).then(
                    () => {
                      if (stageMessageId === staleId) stageMessageId = undefined
                    },
                    () => undefined
                  )
                }
              },
              host: {
                send: async (content, phase) => {
                  // 첫 전송부터 중지 버튼을 실어 보낸다. 사용자가 본문을 보기
                  // 시작하는 시점에 이미 멈출 수 있어야 한다.
                  const payload =
                    phase === 'final'
                      ? toAiFinalMessage(content)
                      : attachStopButton(
                          toComponentV2(content, 1).components,
                          turn.turnId
                        )
                  const sent = await message.reply({ content: '', ...payload })
                  return {
                    edit: async (next, phase) => {
                      await editStreamingMessage(
                        message,
                        sent.id,
                        next,
                        turn.turnId,
                        phase
                      )
                    },
                    id: sent.id,
                    delete: () => message.channel.messages.delete(sent.id),
                  }
                },
                setTyping: () => {
                  const channel = message.channel
                  if (
                    'sendTyping' in channel &&
                    typeof channel.sendTyping === 'function'
                  ) {
                    void channel.sendTyping()
                  }
                },
              },
            }),
          reply: (reply) => {
            replyComplete = (async () => {
              if (reply.type === 'embed') {
                const embed = new EmbedBuilder()
                  .setTitle(reply.embed.title)
                  .setDescription(reply.embed.description)
                  .addFields(
                    reply.embed.fields.map((f) => ({
                      name: f.name,
                      value: f.value,
                    }))
                  )
                const sent = await message.reply({ embeds: [embed] })
                botMessageId = sent.id
              } else {
                const cleaned = stripThinkTags(reply.content)
                const v2 = toAiFinalMessage(cleaned)
                const sent = await message.reply(v2)
                botMessageId = sent.id
                lastBotResponse = cleaned
                  .split('\n\n-#')[0]
                  .split('\n\n> 사용:')[0]
                  .trim()
              }
              if (stageMessageId !== undefined) {
                try {
                  await message.channel.messages.delete(stageMessageId)
                } catch (err) {
                  // already deleted
                }
              }
            })()
          },
        })
      )

      await replyComplete
      if (stageMessageId !== undefined) {
        await message.channel.messages
          .delete(stageMessageId)
          .catch(() => undefined)
        stageMessageId = undefined
      }

      // 스트리밍 경로에서는 답장이 이미 화면에 있으므로 reply()로 다시 보내지
      // 않는다. 세션 바인딩만 그 메시지 id에 묶는다.
      const streamedMessageId = result.streamedMessageId
      if (streamedMessageId !== undefined && botMessageId === undefined) {
        botMessageId = streamedMessageId
        lastBotResponse = result.aiText
      }

      if (result.toolRecords !== undefined && result.toolRecords.length > 0) {
        const sessionKey = getOrCreateSession(
          guildId,
          message.channel.id,
          userId
        )
        appendToToolHistory(sessionKey, result.toolRecords)
      }

      // 두 턴의 선행 조건을 분리해 기록한다.
      //
      // user 턴의 조건: 질문이 만들어졌다면 무조건. 이것이 F5의 핵심이다 —
      // 중단이나 폴백 generate 실패로 aiText가 없더라도, 사용자가 실제로 보낸
      // 질문은 세션에 남아야 한다. 조건을 함께 걸면 질문째로 세션에서 증발하고,
      // 그 AI 메시지에 답장해도 세션을 못 찾아 "대화 기록을 찾지 못했어요"가 뜬다.
      //
      // assistant 턴의 조건: 화면에 남은 메시지가 있고 그 내용이 있을 때.
      if (result.enrichedPrompt !== undefined) {
        const sessionKey = getOrCreateSession(
          guildId,
          message.channel.id,
          userId
        )
        // 손상 여부와 무관하게 항상 원문 그대로 남긴다. 사용자가 뭘 물었는지는
        // 질문이든 실패한 질문이든 온전한 기록이어야 다음 턴이 맥락을 잇는다.
        // 오염 위험은 AI가 만든 텍스트 쪽에만 있다.
        appendToSession(
          sessionKey,
          {
            content: result.enrichedPrompt,
            role: 'user',
            imageUrls: getMessageImageUrls(message),
            authorId: userId,
            sentAt: message.createdAt.toISOString(),
          },
          message.id
        )

        if (
          botMessageId !== undefined &&
          lastBotResponse !== undefined &&
          result.aiText !== undefined
        ) {
          recordAssistantTurn(
            sessionKey,
            result.aiText,
            result.damaged,
            botMessageId,
            result.reasoningSummary
          )
        }
      }

      if (!turn.isStopped()) {
        await this.sendApprovalCards(
          (payload) => message.reply(payload),
          collector,
          botMessageId,
          (id, card) => message.channel.messages.edit(id, card)
        )
      }

      // 온보딩 안내 — AI 응답을 막지 않고 추가 메시지로 전송
      if (guildId.length > 0) {
        const onboardingStatus = await shouldShowOnboarding(
          guildId,
          hasAdmin || isOwner
        )
        if (onboardingStatus === 'show') {
          try {
            const card = buildOnboardingCard(guildId)
            const ch = message.channel
            if ('send' in ch && typeof ch.send === 'function') {
              await ch.send({ content: '', ...card })
            }
            logger.info('Onboarding', `온보딩 안내 전송: guild=${guildId}`)
          } catch (err) {
            logger.debug(
              'Onboarding',
              `온보딩 카드 전송 실패: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          }
        }
      }
    } finally {
      releaseSession()
    }
  }

  private async handleReplyToBotMessage(
    message: Message,
    referencedMessageId: string,
    referencedMessage?: Message
  ): Promise<void> {
    // this.provider는 this 필드라 클로저 안에서 narrowing이 풀린다. 여기서
    // 지역 상수로 고정하면 이후 로직(특히 runTurn 클로저)이 같은 객체를 쓴다.
    const provider = this.provider
    if (provider === undefined) {
      return
    }

    let thinkingMessageId: string | undefined
    let releaseSession: (() => void) | undefined

    try {
      const referenced =
        referencedMessage ??
        (await message.channel.messages.fetch(referencedMessageId))
      if (referenced.author.id !== this.client.user?.id) {
        return
      }
      const traced = getSessionByMessage(referencedMessageId)
      if (
        traced === undefined ||
        traced.session.guildId !== (message.guild?.id ?? '') ||
        traced.session.channelId !== message.channel.id ||
        isExpired(traced.session)
      ) {
        return
      }

      const hasManageGuild =
        message.member?.permissions.has(PermissionFlagsBits.ManageGuild) ??
        false
      const isOwner = message.guild?.ownerId === message.author.id
      const hasAdmin =
        message.member?.permissions.has(PermissionFlagsBits.Administrator) ??
        false

      const userMessage = message.content.replace(/<@!?\d+>/u, '').trim()
      const imageUrls = getMessageImageUrls(message)
      if (userMessage.length === 0 && imageUrls.length === 0) {
        return
      }

      releaseSession = acquireSessionTurn(traced.sessionKey)
      if (releaseSession === undefined) {
        await message.reply(
          '이 대화의 이전 응답이 아직 진행 중이에요. 끝난 뒤 다시 요청해 주세요.'
        )
        return
      }

      const referencedContent = stripThinkTags(referenced.content)
        .split('\n\n-#')[0]
        .trim()

      const sent = await message.reply(
        '<a:kirakira:1519382939778158784> AI가 답장을 생각하고 있어요..'
      )
      thinkingMessageId = sent.id
      if (
        'sendTyping' in message.channel &&
        typeof message.channel.sendTyping === 'function'
      ) {
        void message.channel.sendTyping()
      }

      const collector = createProposalCollector()
      const replyContext: ToolExecutionContext = {
        guildId: message.guild?.id ?? '',
        guildName: message.guild?.name ?? '',
        userId: message.author.id,
        channelId: message.channel.id,
      }

      // 스트리밍은 이미 보낸 "답장 생각 중" 메시지를 그대로 이어붙여 편집한다.
      // 새 메시지를 만들지 않으므로 중복 전송이 생기지 않는다.
      //
      // 턴은 여기서 연다. thinking 메시지(sent)가 이미 화면에 있으므로 이번
      // 경로는 messageId를 넘길 수 있고, 중지 버튼이 붙는 대상도 그 메시지다.
      const turn = beginTurn({
        requesterId: message.author.id,
        guildId: message.guild?.id ?? '',
        channelId: message.channel.id,
        messageId: sent.id,
      })
      const tools = this.buildToolDefinitions(
        replyContext,
        hasManageGuild,
        hasAdmin,
        message.member?.permissions.has(PermissionFlagsBits.ManageChannels) ??
          false,
        collector,
        turn.controller.signal
      )
      // 턴과 함께 죽어야 할 부수 타이머들(반복 감지 정지 타이머).
      const loopStopTimers = new Set<ReturnType<typeof setTimeout>>()

      const stream = createStreamRenderer({
        // 멘션 경로와 같은 불변식: 반복 감지 후에도 provider는 멈추되, 그 사이
        // complete()가 실행됐다면 건너뛴다. 살릴 앞부분이 화면에 확정된 뒤에
        // 멈춰야 저장과 표시가 어긋나지 않는다.
        onLoopDetected: (kind) => {
          if (kind !== 'repetition') {
            return
          }
          const stopTimer = setTimeout(() => {
            if (turn.isStopped()) {
              return
            }
            logger.warn('AI', `반복 감지로 답장 턴 정지: turn=${turn.turnId}`)
            turn.stop('loop-guard')
          }, LOOP_STOP_GRACE_MS)
          loopStopTimers.add(stopTimer)
        },
        host: {
          send: async (content, phase) => {
            await editStreamingMessage(
              message,
              sent.id,
              content,
              turn.turnId,
              phase
            )
            return {
              edit: async (next, phase) => {
                await editStreamingMessage(
                  message,
                  sent.id,
                  next,
                  turn.turnId,
                  phase
                )
              },
              id: sent.id,
              delete: () => message.channel.messages.delete(sent.id),
            }
          },
          setTyping: () => {
            if (
              'sendTyping' in message.channel &&
              typeof message.channel.sendTyping === 'function'
            ) {
              void message.channel.sendTyping()
            }
          },
        },
      })

      let responseMessageId: string | undefined
      const result = await runTurn(turn, loopStopTimers, async (onActivity) =>
        handleSessionReply({
          approvalPending: () => collector.hasPending(),
          guildId: message.guild?.id ?? '',
          userId: message.author.id,
          referencedMessageId,
          previousBotResponse: referencedContent,
          provider,
          userMessage: userMessage || '첨부한 이미지를 설명해 주세요.',
          userMessageId: message.id,
          sentAt: message.createdAt.toISOString(),
          imageUrls,
          memberDisplayName:
            message.member?.displayName ?? message.author.displayName,
          guildName: message.guild?.name,
          channelId: message.channel.id,
          channelName: message.channel.isDMBased()
            ? undefined
            : message.channel.name,
          hasManageGuild,
          isOwner,
          permissionSummary: summarizeMemberPermissions(
            message.member?.permissions,
            { isOwner }
          ),
          tools,
          commandCatalog: await getCommandCatalog(message.guild),
          recentMessages: await getRecentMessagesForPrompt(message),
          openStream: stream,
          abortSignal: turn.controller.signal,
          onActivity,
        })
      )

      if (result.streamedMessageId !== undefined) {
        // 답장이 이미 thinking 메시지에 실렸으므로 삭제는 이미 확정됐고,
        // 세션만 그 메시지에 묶는다.
        thinkingMessageId = undefined
        responseMessageId = result.streamedMessageId
        // 2단계에서는 중단 시 이 append를 통째로 스킵했는데, 지금은 마커로
        // 저장한다. 스킵하면 다음 턴의 모델에게 '답변은 없고 질문만 남은
        // 대화'가 보여, 같은 질문을 그대로 다시 시도하거나 되묻는 등 새로운
        // 어색함이 생긴다. 마커는 "답이 없었고 이유는 이거다"를 분명히 주므로
        // 모델이 다른 접근을 시도할 수 있다. 게다가 스킵하면 bindMessage가
        // 일어나지 않아 이 AI 메시지에 답장을 달아도 세션을 못 찾는다.
        recordAssistantTurn(
          result.sessionKey,
          result.assistantText,
          result.damaged,
          result.streamedMessageId,
          result.reasoningSummary
        )
      } else {
        try {
          await message.channel.messages.delete(sent.id)
          thinkingMessageId = undefined
        } catch (err) {
          // already deleted
        }

        const v2 = toAiFinalMessage(result.response)
        const replyMsg = await message.reply(v2)
        responseMessageId = replyMsg.id
        recordAssistantTurn(
          result.sessionKey,
          result.assistantText,
          result.damaged,
          replyMsg.id,
          result.reasoningSummary
        )
      }

      if (result.toolRecords !== undefined && result.toolRecords.length > 0) {
        appendToToolHistory(result.sessionKey, result.toolRecords)
      }

      if (!turn.isStopped()) {
        await this.sendApprovalCards(
          (payload) => message.reply(payload),
          collector,
          responseMessageId,
          (id, card) => message.channel.messages.edit(id, card)
        )
      }
    } catch (err) {
      logger.error(
        'AI',
        `답장 세션 처리 중 오류: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      if (thinkingMessageId !== undefined) {
        try {
          await message.channel.messages.delete(thinkingMessageId)
        } catch (deleteErr) {
          logger.debug(
            'AI',
            `thinking message cleanup failed: ${
              deleteErr instanceof Error ? deleteErr.message : String(deleteErr)
            }`
          )
        }
      }
      await message
        .reply('AI 답장 처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.')
        .catch((replyErr: unknown) => {
          logger.debug(
            'AI',
            `reply failed: ${
              replyErr instanceof Error ? replyErr.message : String(replyErr)
            }`
          )
        })
    } finally {
      releaseSession?.()
    }
  }

  private async expireApproval(id: string): Promise<void> {
    const proposal = this.pendingApprovals.get(id)
    if (proposal === undefined) return
    if (Date.now() < proposal.expiresAt) {
      clearTimeout(proposal.timer)
      proposal.timer = setTimeout(() => {
        void this.expireApproval(id)
      }, proposal.expiresAt - Date.now())
      return
    }
    this.pendingApprovals.delete(id)
    clearTimeout(proposal.timer)
    const outcome =
      '승인 대기 시간이 지나 자동 거부했어요. 작업은 실행되지 않았어요.'
    const sessionKey = getOrCreateSession(
      proposal.context.guildId,
      proposal.context.channelId,
      proposal.requesterId
    )
    appendToToolHistory(sessionKey, [
      {
        name: proposal.toolName,
        args: proposal.args,
        result: outcome,
        success: false,
      },
    ])
    appendToSession(
      sessionKey,
      { content: outcome, role: 'assistant' },
      proposal.cardMessage.id
    )
    try {
      await proposal.cardMessage.edit(
        buildResolvedApprovalCard({
          toolName: proposal.toolName,
          args: proposal.args,
          requesterId: proposal.requesterId,
          statusLine: '⏰ 자동 거부됨 — 대기 시간이 지났어요.',
          dangerGate: proposal.dangerGate,
        })
      )
    } catch (err) {
      logger.warn(
        'AI',
        `자동 거부 카드 갱신 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  private pruneExpiredApprovals(): void {
    for (const [id, proposal] of this.pendingApprovals) {
      if (Date.now() >= proposal.expiresAt) void this.expireApproval(id)
    }
  }

  // generate 종료 후, 보류된 위험 도구 제안들을 승인 카드로 전송하고 대기 목록에 등록한다.
  private async sendApprovalCards(
    send: (payload: MessageCreateOptions) => Promise<Message>,
    collector: ProposalCollector,
    responseMessageId?: string,
    edit?: (
      id: string,
      card: ReturnType<typeof buildApprovalCard>
    ) => Promise<Message>
  ): Promise<void> {
    const proposals = collector.drain()
    if (proposals.length === 0) return

    this.pruneExpiredApprovals()
    for (const [index, proposal] of proposals.entries()) {
      try {
        const approvalPolicy = (
          await getServerProfile(proposal.context.guildId)
        ).approvalPolicy
        const dangerGate = approvalPolicy.dangerGate
        const card = buildApprovalCard({
          toolName: proposal.toolName,
          args: proposal.args,
          requesterId: proposal.requesterId,
          proposalId: proposal.id,
          timeoutSeconds: approvalPolicy.timeoutSeconds,
          dangerGate,
        })
        const payload = { content: '', ...card }
        let cardMessage: Message
        if (
          index === 0 &&
          responseMessageId !== undefined &&
          edit !== undefined
        ) {
          try {
            cardMessage = await edit(responseMessageId, card)
          } catch (editError) {
            logger.warn(
              'AI',
              `기존 답변에 승인 카드 표시 실패, 새 카드로 재시도: ${
                editError instanceof Error
                  ? editError.message
                  : String(editError)
              }`
            )
            cardMessage = await send(payload)
          }
        } else {
          cardMessage = await send(payload)
        }
        const expiresAt = Date.now() + approvalPolicy.timeoutSeconds * 1000
        const timer = setTimeout(() => {
          void this.expireApproval(proposal.id)
        }, approvalPolicy.timeoutSeconds * 1000)
        this.pendingApprovals.set(proposal.id, {
          ...proposal,
          cardMessage,
          expiresAt,
          timer,
          dangerGate,
        })
        if (cardMessage.id !== responseMessageId) {
          const sessionKey = getOrCreateSession(
            proposal.context.guildId,
            proposal.context.channelId,
            proposal.requesterId
          )
          appendToSession(
            sessionKey,
            { content: '승인 대기 중인 작업이 있어요.', role: 'assistant' },
            cardMessage.id
          )
        }
        logger.info(
          'TOOL',
          `승인 카드 전송: ${proposal.toolName} (id=${proposal.id})`
        )
      } catch (err) {
        logger.error(
          'AI',
          `승인 카드 전송 실패: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        const sessionKey = getOrCreateSession(
          proposal.context.guildId,
          proposal.context.channelId,
          proposal.requesterId
        )
        appendToToolHistory(sessionKey, [
          {
            name: proposal.toolName,
            args: proposal.args,
            result: '승인 카드를 보내지 못해 작업을 실행하지 않았어요.',
            success: false,
          },
        ])
        appendToSession(sessionKey, {
          content: '승인 카드를 보내지 못해 작업을 실행하지 않았어요.',
          role: 'assistant',
        })
        try {
          await send({
            content:
              '승인 카드를 보내지 못해 작업을 실행하지 않았어요. 잠시 후 다시 요청해 주세요.',
          })
        } catch (noticeError) {
          logger.error(
            'AI',
            `승인 카드 실패 안내 전송 실패: ${
              noticeError instanceof Error
                ? noticeError.message
                : String(noticeError)
            }`
          )
        }
      }
    }
  }

  @listener({ event: 'interactionCreate' })
  async onboardingInteraction(interaction: MessageComponentInteraction) {
    if (!interaction.isButton()) return
    const parsed = parseOnboardingCustomId(interaction.customId)
    if (parsed === undefined) return

    const hasAdmin =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ??
      false
    const isOwner = interaction.guild?.ownerId === interaction.user.id

    if (!hasAdmin && !isOwner) {
      await interaction
        .reply({
          content: '관리자만 온보딩 설정을 할 수 있어요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch((err: unknown) => {
          logger.debug(
            'Onboarding',
            `reply failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      return
    }

    switch (parsed.action) {
      case 'start': {
        try {
          await upsertServerProfile(parsed.guildId, {
            onboardedAt: new Date(),
          })
          await interaction
            .update(
              buildOnboardingResolvedCard(
                '✅ 온보딩 완료! `/에이전트 설정`으로 세부 설정을 변경할 수 있어요.'
              )
            )
            .catch((err: unknown) => {
              logger.debug(
                'Onboarding',
                `card update failed: ${
                  err instanceof Error ? err.message : String(err)
                }`
              )
            })
          logger.info(
            'Onboarding',
            `온보딩 완료: guild=${parsed.guildId} user=${interaction.user.id}`
          )
        } catch (err) {
          logger.error(
            'Onboarding',
            `온보딩 완료 처리 오류: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
          await interaction
            .reply({
              content:
                '온보딩 처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.',
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => undefined)
        }
        break
      }
      case 'dismiss2h': {
        await dismissOnboarding(parsed.guildId, '2h')
        await interaction
          .update(buildOnboardingResolvedCard('⏰ 2시간 뒤에 다시 안내할게요.'))
          .catch((err: unknown) => {
            logger.debug(
              'Onboarding',
              `card update failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        break
      }
      case 'dismiss24h': {
        await dismissOnboarding(parsed.guildId, '24h')
        await interaction
          .update(
            buildOnboardingResolvedCard('📅 오늘은 더 안내하지 않을게요.')
          )
          .catch((err: unknown) => {
            logger.debug(
              'Onboarding',
              `card update failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        break
      }
      case 'dismissChat': {
        await dismissOnboarding(parsed.guildId, 'next_chat')
        await interaction
          .update(
            buildOnboardingResolvedCard(
              '👋 닫았어요. 다음에 말 걸면 다시 안내할게요.'
            )
          )
          .catch((err: unknown) => {
            logger.debug(
              'Onboarding',
              `card update failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        break
      }
    }
  }

  /**
   * 스트리밍 응답 중지 버튼.
   *
   * customId가 'aiStop:...'로 시작하지 않으면 다른 핸들러(승인 aiApproval,
   * 온보딩 aiOnboarding, 패널 aiAgentConfig)가 맡는 영역이므로 즉시 return한다.
   * 라우팅 오배치가 있으면 여기서 남의 버튼을 먹어 버리므로, 조용히 넘기는 것이
   * 다른 핸들러의 소유권을 지키는 가장 확실한 방법이다(승인 카드와 동일 관례).
   */
  @listener({ event: 'interactionCreate' })
  async stopTurnInteraction(interaction: MessageComponentInteraction) {
    if (!interaction.isButton()) return
    const parsed = parseStopCustomId(interaction.customId)
    if (parsed === undefined) return

    // ephemeral 안내의 공통 형태. 상호작용은 3초 안에 응답해야 하므로 오래 걸리는
    // 작업 없이 항상 바로 답한다.
    const acknowledge = (content: string) =>
      interaction
        .reply({ content, flags: MessageFlags.Ephemeral })
        .catch((err: unknown) => {
          logger.debug(
            'AI',
            `중지 버튼 응답 실패: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        })

    const turn = getTurn(parsed.turnId)
    if (turn === undefined) {
      // 이미 끝난 응답. 사용자에게는 조용히 통과시키되 왜 안 되는지는 알린다.
      await acknowledge('이미 끝난 응답이에요.')
      return
    }

    // 결정 주체는 요청자 본인이다. 승인 카드와 같은 취급이다 — 남의 AI 응답을
    // 멈추면 대화 흐름이 다른 사람의 것으로 뒤집히고, 남의 질문이 도중에 잘린다.
    if (interaction.user.id !== turn.requesterId) {
      await acknowledge('요청한 분만 멈출 수 있어요.')
      return
    }

    // 멱등이라 더블클릭해도 안전하다. 이미 멈춘 턴이면 그대로 통과한다.
    turn.stop('user-stop')
    logger.info(
      'AI',
      `사용자 중단: turn=${turn.turnId} user=${interaction.user.id}`
    )
    await acknowledge('⏹️ 응답을 멈췄어요.')
  }

  @listener({ event: 'interactionCreate' })
  async approvalInteraction(interaction: MessageComponentInteraction) {
    if (!interaction.isButton()) return
    const parsed = parseApprovalCustomId(interaction.customId)
    if (parsed === undefined) return

    const proposal = this.pendingApprovals.get(parsed.proposalId)
    if (proposal === undefined) {
      await interaction
        .reply({
          content: '이미 처리됐거나 만료된 승인 요청이에요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch((err: unknown) => {
          logger.debug(
            'AI',
            `reply failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      return
    }

    if (
      !interaction.guildId ||
      interaction.guildId !== proposal.context.guildId ||
      interaction.channelId !== proposal.context.channelId
    ) {
      await interaction.reply({
        content: '요청한 서버와 채널에서만 승인할 수 있어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const [clickerRoles, clicker] = await Promise.all([
      interaction.guild?.roles.fetch().catch(() => null),
      interaction.guild?.members
        .fetch({ user: interaction.user.id, force: true })
        .catch(() => null),
    ])
    if (!clicker || !clickerRoles) {
      await interaction.reply({
        content: '현재 서버 권한을 확인할 수 없어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    // 결정 주체는 서버 승인 정책을 따른다: admin_only=관리자만, 그 외=요청자 본인.
    // (none 정책은 애초에 제안이 생성되지 않지만, 보류 중 정책이 바뀐 경우 요청자 규칙으로 처리)
    const dangerGate = (await getServerProfile(proposal.context.guildId))
      .approvalPolicy.dangerGate
    if (dangerGate === 'admin_only') {
      const clickerIsAdmin =
        clicker.permissions.has(PermissionFlagsBits.Administrator) ||
        interaction.guild?.ownerId === interaction.user.id
      if (!clickerIsAdmin) {
        await interaction
          .reply({
            content: '관리자만 이 작업을 승인하거나 거부할 수 있어요.',
            flags: MessageFlags.Ephemeral,
          })
          .catch((err: unknown) => {
            logger.debug(
              'AI',
              `reply failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        return
      }
    } else if (interaction.user.id !== proposal.requesterId) {
      await interaction
        .reply({
          content: '작업을 요청한 분만 결정할 수 있어요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch((err: unknown) => {
          logger.debug(
            'AI',
            `reply failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      return
    }

    // 만료 타이머나 다른 클릭이 먼저 소비했다면 도구를 실행하지 않는다.
    if (this.pendingApprovals.get(parsed.proposalId) !== proposal) {
      await interaction
        .reply({
          content: '이미 처리됐거나 자동 거부된 승인 요청이에요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined)
      return
    }
    if (Date.now() >= proposal.expiresAt) {
      await this.expireApproval(parsed.proposalId)
      await interaction
        .reply({
          content: '대기 시간이 지나 자동 거부됐어요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined)
      return
    }

    // 여기서부터 단일 소비 보장 — 더블클릭/중복 처리를 막기 위해 먼저 제거한다.
    this.pendingApprovals.delete(parsed.proposalId)
    clearTimeout(proposal.timer)

    const resolveCard = (statusLine: string) =>
      buildResolvedApprovalCard({
        toolName: proposal.toolName,
        args: proposal.args,
        requesterId: proposal.requesterId,
        statusLine,
        dangerGate,
      })
    let acknowledged = false
    const updateCard = async (statusLine: string): Promise<boolean> => {
      try {
        if (!acknowledged) {
          await interaction.update(resolveCard(statusLine))
          acknowledged = true
        } else {
          await interaction.message.edit(resolveCard(statusLine))
        }
        return true
      } catch (err) {
        logger.error(
          'AI',
          `승인 카드 갱신 실패: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        return false
      }
    }
    const sessionKey = getOrCreateSession(
      proposal.context.guildId,
      proposal.context.channelId,
      proposal.requesterId
    )
    const recordOutcome = (message: string, success: boolean): void => {
      appendToToolHistory(sessionKey, [
        {
          name: proposal.toolName,
          args: proposal.args,
          result: message,
          success,
        },
      ])
      appendToSession(
        sessionKey,
        {
          content: message,
          role: 'assistant',
        },
        interaction.message.id
      )
    }

    if (parsed.action === 'deny') {
      const outcome = '사용자가 작업을 거부했어요. 작업은 실행되지 않았어요.'
      await updateCard('🚫 거부됨 — 작업을 실행하지 않았어요.')
      recordOutcome(outcome, false)
      return
    }

    if (Date.now() >= proposal.expiresAt) {
      await updateCard('⏰ 만료됨 — 필요하면 다시 요청해 주세요.')
      recordOutcome('승인 요청이 만료되어 작업을 실행하지 않았어요.', false)
      return
    }

    const toolDef = this.toolRegistry?.get(proposal.toolName)
    if (toolDef === undefined) {
      await updateCard('❌ 작업 정보를 찾을 수 없어요.')
      recordOutcome('승인된 작업 정보를 찾지 못해 실행하지 않았어요.', false)
      return
    }

    const executeCheck = await checkLiveToolPermission(
      this.client,
      toolDef,
      proposal.args,
      proposal.context
    )
    if (!executeCheck.ok) {
      await updateCard(`⛔ ${executeCheck.reason}`)
      recordOutcome(`권한 확인 실패: ${executeCheck.reason}`, false)
      return
    }

    if (!(await updateCard('✅ 승인됨 — 실행 중...'))) {
      // Discord가 interaction을 받지 못했다면 도구를 실행하지 않는다.
      this.pendingApprovals.set(parsed.proposalId, proposal)
      const remaining = proposal.expiresAt - Date.now()
      if (remaining > 0) {
        proposal.timer = setTimeout(() => {
          void this.expireApproval(parsed.proposalId)
        }, remaining)
      } else {
        void this.expireApproval(parsed.proposalId)
      }
      return
    }

    try {
      const current = await checkLiveToolPermission(
        this.client,
        toolDef,
        proposal.args,
        proposal.context
      )
      if (!current.ok) {
        await updateCard(`⛔ ${current.reason}`)
        recordOutcome(`권한 확인 실패: ${current.reason}`, false)
        return
      }
      const result = await toolDef.execute(proposal.args, proposal.context)
      logger.info(
        'TOOL',
        `승인 실행: ${proposal.toolName} 성공=${result.success}`
      )
      const outcome = result.success
        ? `작업 완료: ${result.message}`
        : `작업 실패: ${result.message}`
      recordOutcome(outcome, result.success)
      if (
        !(await updateCard(result.success ? `✅ ${outcome}` : `❌ ${outcome}`))
      ) {
        await interaction.followUp({ content: outcome }).catch(() => undefined)
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      logger.error('AI', `승인 작업 실행 오류: ${detail}`)
      recordOutcome(`작업 실행 중 오류: ${detail}`, false)
      if (
        !(await updateCard(
          '❌ 작업 실행 중 오류가 발생했어요. 이 메시지에 답장해 다시 요청해 주세요.'
        ))
      ) {
        await interaction
          .followUp({ content: '작업 실행 중 오류가 발생했어요.' })
          .catch(() => undefined)
      }
    }
  }

  // ── /에이전트 서브커맨드 ──

  // requireServerManager는 CommandAccessError를 던지지만 전역 invokeError 핸들러는
  // 로그만 남긴다 — 사용자에게 거부 사유를 알리려면 여기서 흡수해 ephemeral로 응답해야 한다.
  private async guardServerManager(
    i: ChatInputCommandInteraction
  ): Promise<boolean> {
    try {
      requireServerManager(i)
      return true
    } catch (err) {
      if (err instanceof CommandAccessError) {
        await replyEphemeral(i, err.messageForUser)
        return false
      }
      throw err
    }
  }

  private async buildPanelData(
    guildId: string,
    selectedChannelId: string | null
  ): Promise<AgentPanelData> {
    const profile = await getServerProfile(guildId)
    this.pruneExpiredApprovals()
    let pendingCount = 0
    for (const proposal of this.pendingApprovals.values()) {
      if (proposal.context.guildId === guildId) pendingCount++
    }
    return {
      soul: getSoul(profile),
      concept: profile.concept,
      dangerGate: profile.approvalPolicy.dangerGate,
      timeoutSeconds: profile.approvalPolicy.timeoutSeconds,
      standingOrders: getStandingOrders(profile),
      channelRoles: profile.channelRoles,
      selectedChannelId,
      activeSessions: getActiveSessionsCount(guildId),
      pendingApprovals: pendingCount,
      onboardedAt: profile.onboardedAt,
    }
  }

  private async updatePanel(
    interaction:
      | MessageComponentInteraction
      | ModalMessageModalSubmitInteraction,
    guildId: string
  ): Promise<void> {
    const data = await this.buildPanelData(
      guildId,
      this.panelSelectedChannel.get(interaction.message.id) ?? null
    )
    await interaction.update(buildAgentSettingsPanel(data))
  }

  // 컴포넌트/모달 인터랙션용 관리 권한 검사(관리자·서버관리·오너).
  private canManagePanel(
    interaction: MessageComponentInteraction | ModalSubmitInteraction
  ): boolean {
    return (
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ===
        true ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ===
        true ||
      interaction.guild?.ownerId === interaction.user.id
    )
  }

  @agentGroup.command({
    name: '안내',
    description: 'AI와 대화하는 방법과 내 세션 관리 명령을 확인합니다.',
  })
  async agentHelp(i: ChatInputCommandInteraction) {
    await replyEphemeral(
      i,
      [
        '🤖 **AI 대화 안내**',
        '- 메시지 맨 앞에 봇을 멘션하고 질문해 주세요. 이미지를 함께 첨부할 수도 있어요.',
        '- 멘션으로 시작한 대화는 요청자별로 관리해요. 다른 사용자도 AI 답장에 답장하면 참여할 수 있어요.',
        '- 마지막 활동 후 3일이 지나면 OLD 대화가 되어 이어갈 수 없어요.',
        '- `/에이전트 내세션`으로 이 채널의 대화 상태를 확인할 수 있어요.',
        '- `/에이전트 내세션초기화`로 이 채널의 내 대화만 지울 수 있어요.',
        '- `/에이전트 셋업`과 `/에이전트 상태`는 서버 관리자용이에요.',
      ].join('\n')
    )
  }

  @agentGroup.command({
    name: '내세션',
    description: '이 채널에서 내 AI 대화 세션 상태를 확인합니다.',
  })
  async agentMySession(i: ChatInputCommandInteraction) {
    const session = getUserSessionInfo(i.guildId ?? '', i.channelId, i.user.id)
    await replyEphemeral(
      i,
      session === undefined
        ? '이 채널에 진행 중인 AI 대화가 없어요. 봇을 멘션해 시작해 주세요.'
        : `이 채널에 AI 대화가 있어요. 저장된 메시지 ${
            session.messageCount
          }개 · 이미지 ${session.imageCount}개 · 마지막 활동 ${new Date(
            session.lastActivity
          ).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`
    )
  }

  @agentGroup.command({
    name: '내세션초기화',
    description: '이 채널의 내 AI 대화 세션만 초기화합니다.',
  })
  async agentClearMySession(i: ChatInputCommandInteraction) {
    await i.deferReply({ flags: MessageFlags.Ephemeral })
    const cleared = await clearUserSession(
      i.guildId ?? '',
      i.channelId,
      i.user.id
    )
    await i.editReply({
      content:
        cleared === undefined
          ? '이 대화의 응답이 진행 중이에요. 끝난 뒤 초기화해 주세요.'
          : cleared
          ? '이 채널의 내 AI 대화를 초기화했어요. 다음 멘션부터 새 대화로 시작해요.'
          : '이 채널에 초기화할 AI 대화가 없어요.',
    })
  }

  @agentGroup.command({
    name: '셋업',
    description:
      '관리자: 에이전트의 정체성(소울)·서버 이해·자율 범위를 설정하는 패널을 엽니다.',
  })
  async agentSetup(i: ChatInputCommandInteraction) {
    if (!(await this.guardServerManager(i))) return
    const guild = i.guild
    if (guild === null) return

    const data = await this.buildPanelData(guild.id, null)
    await i.reply(buildAgentSettingsPanel(data))
    const panelMessage = await i.fetchReply()
    this.panelSelectedChannel.set(panelMessage.id, null)
  }

  @agentGroup.command({
    name: '상태',
    description:
      '관리자: 에이전트가 지금 무엇을 알고 무엇을 하고 있는지 확인합니다.',
  })
  async agentStatus(i: ChatInputCommandInteraction) {
    if (!(await this.guardServerManager(i))) return
    const guild = i.guild
    if (guild === null) return

    const profile = await getServerProfile(guild.id)
    const activeSessions = getActiveSessionsCount(guild.id)

    this.pruneExpiredApprovals()
    let pendingCount = 0
    for (const proposal of this.pendingApprovals.values()) {
      if (proposal.context.guildId === guild.id) pendingCount++
    }

    const orders = getStandingOrders(profile)
    const soul = getSoul(profile)

    const channelRoleEntries = Object.entries(profile.channelRoles)
    const channelLines =
      channelRoleEntries.length > 0
        ? channelRoleEntries
            .slice(0, 5)
            .map(([channelId, purpose]) => `  - <#${channelId}>: ${purpose}`)
            .join('\n') +
          (channelRoleEntries.length > 5
            ? `\n  - …외 ${channelRoleEntries.length - 5}개`
            : '')
        : '  - 없음'
    const onboardingLine =
      profile.onboardedAt !== null
        ? `완료 (${profile.onboardedAt.toLocaleDateString('ko-KR', {
            timeZone: 'Asia/Seoul',
          })})`
        : '미완료'
    const soulLine =
      soul !== null
        ? soul.length > 120
          ? `${soul.slice(0, 119)}…`
          : soul
        : '미설정'

    await replyEphemeral(
      i,
      [
        '🤖 **AI 에이전트 상태**',
        `- 소울: ${soulLine}`,
        `- 서버 컨셉: ${profile.concept ?? '미설정'}`,
        `- 상시 지침: ${orders.length}개`,
        `- 위험 작업 승인 정책: ${
          DANGER_GATE_LABELS[profile.approvalPolicy.dangerGate]
        } · ${profile.approvalPolicy.timeoutSeconds}초 뒤 자동 거부`,
        `- 활성 세션: ${activeSessions}개 · 승인 대기: ${pendingCount}건`,
        '- 채널 용도:',
        channelLines,
        `- 온보딩: ${onboardingLine}`,
        '',
        '-# 설정 변경은 `/에이전트 셋업`에서 할 수 있어요.',
      ].join('\n')
    )
  }

  @listener({ event: 'interactionCreate' })
  async agentConfigInteraction(interaction: MessageComponentInteraction) {
    if (!interaction.isMessageComponent()) return
    if (!interaction.customId.startsWith(AGENT_CFG_PREFIX)) return
    const guild = interaction.guild
    if (guild === null) return

    if (!this.canManagePanel(interaction)) {
      await interaction
        .reply({
          content: '서버 관리 권한이 있는 사용자만 설정을 바꿀 수 있어요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined)
      return
    }

    const action = interaction.customId.slice(AGENT_CFG_PREFIX.length)
    const guildId = guild.id
    const selected =
      this.panelSelectedChannel.get(interaction.message.id) ?? null

    try {
      if (
        interaction.isStringSelectMenu() &&
        action === AGENT_CFG_ACTIONS.policy
      ) {
        const value = interaction.values[0]
        if (
          value === 'admin_only' ||
          value === 'requester' ||
          value === 'none'
        ) {
          await upsertServerProfile(guildId, {
            approvalPolicy: {
              ...(await getServerProfile(guildId)).approvalPolicy,
              dangerGate: value,
            },
          })
        }
        await this.updatePanel(interaction, guildId)
        return
      }

      if (
        interaction.isStringSelectMenu() &&
        action === AGENT_CFG_ACTIONS.timeout
      ) {
        const seconds = Number(interaction.values[0])
        if (APPROVAL_TIMEOUT_OPTIONS.some((option) => option === seconds)) {
          await upsertServerProfile(guildId, {
            approvalPolicy: {
              ...(await getServerProfile(guildId)).approvalPolicy,
              timeoutSeconds: seconds,
            },
          })
        }
        await this.updatePanel(interaction, guildId)
        return
      }

      if (
        interaction.isChannelSelectMenu() &&
        action === AGENT_CFG_ACTIONS.roleChannel
      ) {
        this.panelSelectedChannel.set(
          interaction.message.id,
          interaction.values[0] ?? null
        )
        await this.updatePanel(interaction, guildId)
        return
      }

      if (!interaction.isButton()) return

      if (action === AGENT_CFG_ACTIONS.soulEdit) {
        const profile = await getServerProfile(guildId)
        await interaction.showModal(buildSoulModal(getSoul(profile)))
        return
      }

      if (action === AGENT_CFG_ACTIONS.conceptEdit) {
        const profile = await getServerProfile(guildId)
        await interaction.showModal(buildConceptModal(profile.concept))
        return
      }

      if (action === AGENT_CFG_ACTIONS.orderAdd) {
        const profile = await getServerProfile(guildId)
        if (getStandingOrders(profile).length >= MAX_STANDING_ORDERS) {
          await interaction.reply({
            content: `상시 지침은 최대 ${MAX_STANDING_ORDERS}개까지예요. 비운 뒤 다시 추가해 주세요.`,
            flags: MessageFlags.Ephemeral,
          })
          return
        }
        await interaction.showModal(buildOrderAddModal())
        return
      }

      if (action === AGENT_CFG_ACTIONS.orderClear) {
        await setStandingOrders(guildId, [])
        await this.updatePanel(interaction, guildId)
        return
      }

      if (action === AGENT_CFG_ACTIONS.roleEdit) {
        if (selected === null) {
          await interaction.reply({
            content: '채널을 먼저 선택해 주세요.',
            flags: MessageFlags.Ephemeral,
          })
          return
        }
        const profile = await getServerProfile(guildId)
        await interaction.showModal(
          buildRoleModal(selected, profile.channelRoles[selected])
        )
        return
      }

      if (action === AGENT_CFG_ACTIONS.roleRemove) {
        if (selected === null) {
          await interaction.reply({
            content: '채널을 먼저 선택해 주세요.',
            flags: MessageFlags.Ephemeral,
          })
          return
        }
        const profile = await getServerProfile(guildId)
        const channelRoles = { ...profile.channelRoles }
        if (channelRoles[selected] !== undefined) {
          delete channelRoles[selected]
          await upsertServerProfile(guildId, { channelRoles })
        }
        await this.updatePanel(interaction, guildId)
        return
      }

      if (action === AGENT_CFG_ACTIONS.sessionClear) {
        const cleared = await clearSessionsForChannel(
          guildId,
          interaction.channelId
        )
        await this.updatePanel(interaction, guildId)
        await interaction
          .followUp({
            content:
              cleared === undefined
                ? '이 채널에 진행 중인 AI 응답이 있어요. 끝난 뒤 초기화해 주세요.'
                : cleared === 0
                ? '이 채널에는 초기화할 AI 세션이 없어요.'
                : `🧹 이 채널의 AI 세션 ${cleared}개를 초기화했어요. 다음 멘션부터 새 대화로 시작해요.`,
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => undefined)
        return
      }

      if (action === AGENT_CFG_ACTIONS.refresh) {
        await this.updatePanel(interaction, guildId)
        return
      }
    } catch (err) {
      logger.error(
        'AI',
        `에이전트 셋업 패널 오류: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      const errorReply = {
        content: '설정 처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.',
        flags: MessageFlags.Ephemeral,
      } as const
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorReply).catch(() => undefined)
      } else {
        await interaction.reply(errorReply).catch(() => undefined)
      }
    }
  }

  @listener({ event: 'interactionCreate' })
  async agentConfigModal(interaction: ModalSubmitInteraction) {
    if (!interaction.isModalSubmit()) return
    if (!interaction.customId.startsWith(AGENT_CFG_MODAL_PREFIX)) return
    const guild = interaction.guild
    if (guild === null) return

    if (!this.canManagePanel(interaction)) {
      await interaction
        .reply({
          content: '서버 관리 권한이 있는 사용자만 설정을 바꿀 수 있어요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined)
      return
    }

    const kind = interaction.customId.slice(AGENT_CFG_MODAL_PREFIX.length)
    const value = interaction.fields.getTextInputValue('value').trim()

    try {
      if (kind === 'soul') {
        await setSoul(guild.id, value.length === 0 ? null : value)
      } else if (kind === 'concept') {
        await upsertServerProfile(guild.id, {
          concept: value.length === 0 ? null : value,
        })
      } else if (kind === 'order') {
        if (value.length > 0) {
          const profile = await getServerProfile(guild.id)
          const current = getStandingOrders(profile)
          if (current.length < MAX_STANDING_ORDERS) {
            await setStandingOrders(guild.id, [...current, value])
          }
        }
      } else if (kind.startsWith('role:')) {
        const channelId = kind.slice('role:'.length)
        const profile = await getServerProfile(guild.id)
        const channelRoles = { ...profile.channelRoles }
        if (value.length === 0) {
          delete channelRoles[channelId]
        } else {
          channelRoles[channelId] = value
        }
        await upsertServerProfile(guild.id, { channelRoles })
      } else {
        return
      }

      // 패널에서 연 모달이면 패널을 그 자리에서 갱신, 아니면 짧게 확인만.
      if (interaction.isFromMessage()) {
        await this.updatePanel(interaction, guild.id)
      } else {
        await interaction
          .reply({ content: '저장했어요.', flags: MessageFlags.Ephemeral })
          .catch(() => undefined)
      }
    } catch (err) {
      logger.error(
        'AI',
        `에이전트 설정 모달 오류: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      await interaction
        .reply({
          content: '설정 저장 중 오류가 발생했어요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined)
    }
  }
}

export const setup = async () => {
  return new AiMentionExtensionClass()
}
