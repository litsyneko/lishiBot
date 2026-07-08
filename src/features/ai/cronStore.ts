import { logger } from '../../utils/logger'
import { getSupabase } from './supabase'

// cron_jobs DB 계층. 예약(cron)의 진실 원천.
// 테이블 부재(42P01)나 Supabase 미설정 시 조용히 무동작으로 degrade한다(수동 마이그레이션 전제).

const TABLE = 'cron_jobs'

// 안전 액션 종류. 현재는 "AI 에이전트 턴 실행" 하나.
// cron은 임의 코드를 부르지 못하고, 등록된 도구만 쓰는 AI 턴을 돌린다(danger는 승인 게이트).
export type CronJobKind = 'agent_prompt'

export type CronJob = {
  readonly id: number
  readonly guildId: string
  readonly channelId: string | null
  readonly kind: string
  readonly schedule: string // croner 표현식(cron) 또는 ISO 8601(1회성)
  readonly payload: Record<string, unknown>
  readonly tz: string
  readonly enabled: boolean
  readonly createdBy: string
  readonly nextRunAt: Date | null
  readonly lastRunAt: Date | null
  readonly lastRunStatus: string | null
}

export type CreateCronJobInput = {
  readonly guildId: string
  readonly channelId: string | null
  readonly kind: CronJobKind
  readonly schedule: string
  readonly payload: Record<string, unknown>
  readonly tz: string
  readonly createdBy: string
  readonly nextRunAt: Date | null
}

function logCronDbFailure(
  scope: string,
  error: { message?: string; code?: string }
): void {
  // 42P01 = undefined_table. 마이그레이션 미적용 상태이므로 조용히 넘어간다.
  if (error.code === '42P01') return
  logger.warn('CronStore', `${scope} DB 실패: ${error.message ?? 'unknown'}`)
}

function rowToJob(row: Record<string, unknown>): CronJob {
  return {
    id: Number(row.id),
    guildId: row.guild_id as string,
    channelId: (row.channel_id as string) ?? null,
    kind: row.kind as string,
    schedule: row.schedule as string,
    payload:
      row.payload !== null &&
      typeof row.payload === 'object' &&
      !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {},
    tz: (row.tz as string) ?? 'Asia/Seoul',
    enabled: row.enabled !== false,
    createdBy: row.created_by as string,
    nextRunAt:
      typeof row.next_run_at === 'string' ? new Date(row.next_run_at) : null,
    lastRunAt:
      typeof row.last_run_at === 'string' ? new Date(row.last_run_at) : null,
    lastRunStatus: (row.last_run_status as string) ?? null,
  }
}

/** 예약을 생성한다. 실패 시 null(스케줄러/도구가 사용자에게 알림). */
export async function createCronJob(
  input: CreateCronJobInput
): Promise<CronJob | null> {
  const supabase = getSupabase()
  if (supabase === null) return null
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .insert({
        guild_id: input.guildId,
        channel_id: input.channelId,
        kind: input.kind,
        schedule: input.schedule,
        payload: input.payload,
        tz: input.tz,
        created_by: input.createdBy,
        next_run_at: input.nextRunAt?.toISOString() ?? null,
      })
      .select()
      .single()
    if (error !== null) {
      logCronDbFailure('예약 생성', error)
      return null
    }
    return rowToJob(data)
  } catch (err) {
    logger.warn('CronStore', `예약 생성 예외: ${String(err)}`)
    return null
  }
}

/** 길드의 예약 목록. createdBy를 주면 그 유저가 만든 것만. */
export async function listCronJobs(
  guildId: string,
  createdBy?: string
): Promise<CronJob[]> {
  const supabase = getSupabase()
  if (supabase === null) return []
  try {
    let query = supabase.from(TABLE).select('*').eq('guild_id', guildId)
    if (createdBy !== undefined) query = query.eq('created_by', createdBy)
    const { data, error } = await query.order('id', { ascending: true })
    if (error !== null) {
      logCronDbFailure('예약 목록', error)
      return []
    }
    return (data ?? []).map(rowToJob)
  } catch (err) {
    logger.warn('CronStore', `예약 목록 예외: ${String(err)}`)
    return []
  }
}

/** 부팅 시 croner 재등록용 — 활성 예약 전체. */
export async function listAllEnabledCronJobs(): Promise<CronJob[]> {
  const supabase = getSupabase()
  if (supabase === null) return []
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('enabled', true)
    if (error !== null) {
      logCronDbFailure('예약 로드', error)
      return []
    }
    return (data ?? []).map(rowToJob)
  } catch (err) {
    logger.warn('CronStore', `예약 로드 예외: ${String(err)}`)
    return []
  }
}

/**
 * 예약을 삭제한다. requesterId를 주면 본인이 만든 것만 지운다(관리자는 생략).
 * 반환: 실제로 삭제된 건수.
 */
export async function deleteCronJob(
  id: number,
  guildId: string,
  requesterId?: string
): Promise<number> {
  const supabase = getSupabase()
  if (supabase === null) return 0
  try {
    let query = supabase
      .from(TABLE)
      .delete()
      .eq('id', id)
      .eq('guild_id', guildId)
    if (requesterId !== undefined) query = query.eq('created_by', requesterId)
    const { data, error } = await query.select('id')
    if (error !== null) {
      logCronDbFailure('예약 삭제', error)
      return 0
    }
    return (data ?? []).length
  } catch (err) {
    logger.warn('CronStore', `예약 삭제 예외: ${String(err)}`)
    return 0
  }
}

/** 실행 결과 기록(관측용). last_run_at/status + 다음 실행 예정 갱신. */
export async function setCronJobRunStatus(
  id: number,
  status: 'ok' | 'failed' | 'skipped',
  nextRunAt: Date | null
): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) return
  try {
    const { error } = await supabase
      .from(TABLE)
      .update({
        last_run_at: new Date().toISOString(),
        last_run_status: status,
        next_run_at: nextRunAt?.toISOString() ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
    if (error !== null) logCronDbFailure('실행 상태 갱신', error)
  } catch (err) {
    logger.warn('CronStore', `실행 상태 갱신 예외: ${String(err)}`)
  }
}
