import { logger } from '../../utils/logger'
import type { CronJob } from './cronStore'
import { listAllEnabledCronJobs, setCronJobRunStatus } from './cronStore'
import { Cron } from 'croner'

// 인프로세스 croner 스케줄러. 봇이 죽으면 같이 멈춘다(고아 스케줄 없음).
// 스케줄러는 "언제"만 소유하고, 실제 액션 실행(AI 턴)은 runner로 주입받는다.

// 예약이 트리거될 때 실행할 콜백. 실행부(AI 턴)는 AiMentionExtension에서 주입.
export type CronRunner = (job: CronJob) => Promise<void>

// 빈도 상한: 최소 실행 간격(초). 너무 잦은 예약(스팸/비용)을 차단.
export const MIN_INTERVAL_SEC = 5 * 60

// jobId → 살아있는 croner 인스턴스
const active = new Map<number, Cron>()

/**
 * 스케줄 유효성 + 빈도 상한 검증.
 * 문제 있으면 사용자 안내 문자열, 통과면 null.
 */
export function validateSchedule(schedule: string, tz: string): string | null {
  let probe: Cron
  try {
    probe = new Cron(schedule, { timezone: tz, paused: true })
  } catch {
    return '스케줄 형식을 이해하지 못했어요. (예: `0 9 * * 1` = 매주 월요일 9시)'
  }
  const runs = probe.nextRuns(2)
  probe.stop()
  if (runs.length === 0) {
    return '앞으로 실행될 시점이 없는 스케줄이에요.'
  }
  if (runs.length === 2) {
    const gapSec = (runs[1].getTime() - runs[0].getTime()) / 1000
    if (gapSec < MIN_INTERVAL_SEC) {
      return `실행 간격이 너무 짧아요. 최소 ${
        MIN_INTERVAL_SEC / 60
      }분 이상으로 잡아 주세요.`
    }
  }
  return null
}

/** 스케줄의 다음 실행 시각(관측/저장용). 파싱 실패 시 null. */
export function nextRunFor(schedule: string, tz: string): Date | null {
  try {
    const probe = new Cron(schedule, { timezone: tz, paused: true })
    const next = probe.nextRun()
    probe.stop()
    return next
  } catch {
    return null
  }
}

/** 예약 하나를 croner에 등록한다(이미 있으면 교체). */
export function registerCronJob(job: CronJob, runner: CronRunner): boolean {
  unregisterCronJob(job.id)
  try {
    const cron = new Cron(
      job.schedule,
      // protect: 이전 실행이 진행 중이면 중복 실행 방지. unref: 프로세스 종료를 막지 않음.
      { timezone: job.tz, protect: true, unref: true },
      async (self) => {
        try {
          await runner(job)
          await setCronJobRunStatus(job.id, 'ok', self.nextRun())
        } catch (err) {
          logger.error(
            'CronScheduler',
            `예약 실행 실패 id=${job.id}: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
          await setCronJobRunStatus(job.id, 'failed', self.nextRun())
        }
      }
    )
    active.set(job.id, cron)
    return true
  } catch (err) {
    logger.warn(
      'CronScheduler',
      `예약 등록 실패 id=${job.id}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return false
  }
}

/** 예약을 croner에서 해제한다(메모리 스케줄만 중단, DB는 별도). */
export function unregisterCronJob(id: number): void {
  const cron = active.get(id)
  if (cron !== undefined) {
    cron.stop()
    active.delete(id)
  }
}

/** 부팅 시 DB의 활성 예약을 전부 croner에 재등록한다(진실 원천 = DB). */
export async function loadAndRegisterAll(runner: CronRunner): Promise<number> {
  const jobs = await listAllEnabledCronJobs()
  let count = 0
  for (const job of jobs) {
    if (registerCronJob(job, runner)) count += 1
  }
  logger.info('CronScheduler', `${count}개 예약 등록 완료`)
  return count
}
