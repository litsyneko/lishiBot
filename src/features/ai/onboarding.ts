import { logger } from '../../utils/logger'
import {
  getOnboardingDismissedUntil,
  getServerProfile,
  setOnboardingDismissedUntil,
} from './serverProfile'

// ── 온보딩 판정 결과 ──

export type OnboardingStatus =
  | 'show' // 온보딩 미완 + 관리자 + 숨김 아님 → 안내 표시
  | 'dismissed' // 거부로 숨김 중
  | 'completed' // 온보딩 완료
  | 'not_admin' // 관리자 아님

// ── 거부 숨김 (RAM-only, 봇 재시작 시 리셋) ──

type DismissalEntry = {
  /** 숨김 만료 시각 (epoch ms). Infinity = next_chat */
  readonly expiresAt: number
  /** next_chat 모드인 경우 true — 다음 messageCreate에서 해제 */
  readonly isNextChat: boolean
}

// guildId → DismissalEntry
const dismissals = new Map<string, DismissalEntry>()

function isDismissed(guildId: string): boolean {
  const entry = dismissals.get(guildId)
  if (entry === undefined) return false
  if (entry.isNextChat) {
    // next_chat 모드: 이 함수를 호출한 순간이 "다음 채팅"이므로 해제
    dismissals.delete(guildId)
    return false
  }
  if (Date.now() >= entry.expiresAt) {
    dismissals.delete(guildId)
    return false
  }
  return true
}

// ── 공개 API ──

/**
 * 온보딩 안내를 표시해야 하는지 판정한다.
 * - 관리자만 트리거
 * - 프로필 로드 실패 시에도 안전하게 기본값('show') 반환
 */
export async function shouldShowOnboarding(
  guildId: string,
  isAdmin: boolean
): Promise<OnboardingStatus> {
  if (!isAdmin) return 'not_admin'

  if (isDismissed(guildId)) return 'dismissed'

  try {
    const profile = await getServerProfile(guildId)
    if (profile.onboardedAt !== null) return 'completed'
    // 2h/24h 숨김(agent_scope 영속) 체크 — 봇 재시작해도 유지된다.
    const until = getOnboardingDismissedUntil(profile)
    if (until !== null && Date.now() < until) return 'dismissed'
    return 'show'
  } catch (err) {
    logger.warn(
      'Onboarding',
      `프로필 조회 중 예외: ${err instanceof Error ? err.message : String(err)}`
    )
    // 안전하게 show — 온보딩을 놓치는 것보다 한 번 더 보여주는 게 낫다
    return 'show'
  }
}

export type DismissDuration = '2h' | '24h' | 'next_chat'

/**
 * 온보딩 안내를 일시적으로 숨긴다 (RAM-only).
 * - `2h`: 2시간 후 다시 표시
 * - `24h`: 24시간 후 다시 표시
 * - `next_chat`: 다음 메시지(messageCreate) 시 다시 표시
 */
export async function dismissOnboarding(
  guildId: string,
  duration: DismissDuration
): Promise<void> {
  if (duration === 'next_chat') {
    // 세션성 숨김은 RAM 유지 — 재시작 시 다음 채팅에 다시 안내되는 게 의도.
    dismissals.set(guildId, { expiresAt: Infinity, isNextChat: true })
    logger.info('Onboarding', `온보딩 숨김(next_chat): guild=${guildId}`)
    return
  }
  // 2h/24h는 agent_scope에 영속 → 봇 재시작해도 숨김이 유지된다.
  const ms = duration === '2h' ? 2 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  await setOnboardingDismissedUntil(guildId, Date.now() + ms)
  logger.info('Onboarding', `온보딩 숨김(${duration}, DB): guild=${guildId}`)
}
