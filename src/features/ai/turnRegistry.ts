/**
 * 진행 중인 AI 턴 레지스트리 — 인메모리.
 *
 * 역할 하나다. 중지 버튼이 눌렸을 때 "어떤 AbortController를 멈춰야 하는가"를
 * 찾는 것이다. 턴마다 AbortController를 하나씩 들고 있으므로 버튼 customId에
 * 턴 id만 심으면 멈출 대상을 되찾을 수 있다.
 *
 * 설계 의사결정:
 * - 정리는 호출부 책임이다. 턴을 시작한 곳이 반드시 finally로 endTurn을 부른다.
 *   그래야 레지스트리가 상수 크기로 유지된다. 그래도 호출부가 finally를
 *   빠뜨렸을 때 프로세스가 오래 뜨면 Map이 샐 수 있으므로, accessed 턴의
 *   startedAt이 STALE_TURN_MS를 넘으면 읽기에서 즉시 무시하는 안전망을 둔다.
 *   (타이머를 두지 않는 이유: 모듈이 이벤트 루프를 붙잡으면 종료가 어려워진다.
 *   조회는 턴 수만큼만 돌기 때문에 lazy sweep 비용이 무시할 만하다.)
 * - 데드라인 타이머는 이 모듈이 아니라 호출부가 관리한다. 모듈이 setTimeout을
 *   들고 있으면 턴이 이미 끝난 뒤에 예약된 타이머를 추적해야 하고, 그건
 *   "언제 멈출지"라는 정책 판단이라 설정(3단계)과 함께 갈 곳이 된다.
 * - stop()은 멱등이다. 더블클릭, 데드라인과 버튼의 동시 발화, complete 직후의
 *   늦은 클릭이 전부 정상 경로다. 예외를 던지거나 두 번 abort하면 안 된다.
 */
import { logger } from '../../utils/logger'
import { type AiTurnAbortReason, AiTurnAbortedError } from './providerErrors'
import { randomUUID } from 'node:crypto'

/**
 * 10분 하드 상한 직후에도 abort/최종 편집이 진행될 수 있다. 정리 유예를 둔다.
 */
const STALE_TURN_MS = 11 * 60_000

// 중지된 턴도 최종 편집/기록이 끝날 때까지 세션을 점유한다.
const busySessions = new Set<string>()

export function acquireSessionTurn(
  sessionKey: string
): (() => void) | undefined {
  if (busySessions.has(sessionKey)) return undefined
  busySessions.add(sessionKey)
  return () => busySessions.delete(sessionKey)
}

export function isSessionBusy(sessionKey: string): boolean {
  return busySessions.has(sessionKey)
}

export function isChannelBusy(guildId: string, channelId: string): boolean {
  const prefix = `${guildId}:${channelId}:`
  for (const key of busySessions) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

export type ActiveTurn = {
  readonly turnId: string
  readonly controller: AbortController
  readonly requesterId: string
  readonly guildId: string
  readonly channelId: string
  readonly startedAt: number
  /** 화면에 노출된 스트리밍 메시지 id. 버튼이 붙은 메시지. */
  readonly messageId?: string | undefined
  /**
   * 턴을 중단한다. 사유는 기본 'user-stop'(중지 버튼)이고, 데드라인처럼
   * 호출부가 사유를 알고 있으면 넘긴다 — providerCore가 이 값을 signal.reason
   * 에서 읽어 사용자에게 "왜 멈췄는지"를 구분해 보여준다.
   * 멱등: 이미 멈췄거나 턴이 끝났으면 아무 일도 하지 않는다.
   */
  stop: (reason?: AiTurnAbortReason) => void
  /** 사용자 클릭·데드라인으로 중단됐는지 (정상 종료와는 별개). */
  isStopped: () => boolean
}

export type BeginTurnInput = {
  readonly requesterId: string
  readonly guildId: string
  readonly channelId: string
  readonly messageId?: string | undefined
}

type TurnEntry = {
  readonly turn: ActiveTurn
  /** 턴이 끝났음을 표시한다. 이후 stop()은 no-op이 된다. */
  close: () => void
}

// 턴은 동시에 몇 개도 안 돌아간다(사용자 수만큼). 상수 크기 Map 하나면 충분하다.
const turns = new Map<string, TurnEntry>()

function createTurnEntry(input: BeginTurnInput): TurnEntry {
  const controller = new AbortController()
  let stopped = false
  let closed = false

  const turn: ActiveTurn = {
    turnId: randomUUID(),
    controller,
    requesterId: input.requesterId,
    guildId: input.guildId,
    channelId: input.channelId,
    startedAt: Date.now(),
    ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
    stop: (reason = 'user-stop') => {
      if (stopped || closed) {
        return
      }
      stopped = true
      // 사유를 signal.reason에 실어 올린다. 이게 없으면 provider는 중단 이유를
      // 알 수 없어 전부 'external'로 뭉개고, 사용자는 "왜 멈췄는지"를 알 수 없다.
      controller.abort(new AiTurnAbortedError(reason))
    },
    isStopped: () => stopped || controller.signal.aborted,
  }

  return {
    turn,
    close: () => {
      closed = true
    },
  }
}

/** 끝난 턴을 조용히 버린다. 정리의 진짜 책임은 호출부(finally)지만, 그게 빠져도 Map이 무한히 자라지는 일은 막는다. */
function sweepStaleTurns(): void {
  const cutoff = Date.now() - STALE_TURN_MS
  for (const [turnId, entry] of turns) {
    if (entry.turn.startedAt >= cutoff) {
      continue
    }
    entry.close()
    turns.delete(turnId)
  }
}

/** 새 AI 턴을 시작한다. 호출부는 반드시 try/finally로 endTurn을 부른다. */
export function beginTurn(input: BeginTurnInput): ActiveTurn {
  sweepStaleTurns()
  const entry = createTurnEntry(input)
  turns.set(entry.turn.turnId, entry)
  logger.info(
    'AI',
    `턴 시작: turn=${entry.turn.turnId} user=${input.requesterId} channel=${input.channelId}`
  )
  return entry.turn
}

export function getTurn(turnId: string): ActiveTurn | undefined {
  sweepStaleTurns()
  return turns.get(turnId)?.turn
}

/** 같은 사람이 같은 채널에서 이미 돌고 있는 턴. 4단계 중복 멘션 차단을 쓸 수 있다. */
export function getTurnForUser(
  guildId: string,
  channelId: string,
  userId: string
): ActiveTurn | undefined {
  sweepStaleTurns()
  let newest: ActiveTurn | undefined
  for (const entry of turns.values()) {
    const { turn } = entry
    if (
      turn.guildId !== guildId ||
      turn.channelId !== channelId ||
      turn.requesterId !== userId ||
      turn.isStopped()
    ) {
      continue
    }
    if (newest === undefined || turn.startedAt > newest.startedAt) {
      newest = turn
    }
  }
  return newest
}

/** 턴 종료. 반드시 호출부 finally에서 부른다. */
export function endTurn(turnId: string): void {
  const entry = turns.get(turnId)
  if (entry === undefined) {
    return
  }
  entry.close()
  turns.delete(turnId)
}

export function isTurnAlive(turnId: string): boolean {
  return getTurn(turnId) !== undefined
}

/** 진단용. 레지스트리에 남은 턴 수를 노출한다(디버그 로그·모니터링). */
export function getActiveTurnCount(): number {
  sweepStaleTurns()
  return turns.size
}
