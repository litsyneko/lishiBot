import {
  nextRunFor,
  registerCronJob,
  unregisterCronJob,
  validateSchedule,
} from '../../cronScheduler'
import { createCronJob, deleteCronJob, listCronJobs } from '../../cronStore'
import type { ToolDefinition } from '../toolTypes'

const TZ = 'Asia/Seoul'

function toUnix(date: Date | null): string {
  if (date === null) return '미정'
  return `<t:${Math.floor(date.getTime() / 1000)}:F>`
}

// 예약 등록 — 유저 요청을 정해진 시각/주기에 자동 실행하도록 cron_jobs에 저장하고 croner에 건다.
export const scheduleTaskTool: ToolDefinition = {
  declaration: {
    name: 'schedule_task',
    description:
      '사용자의 요청을 정해진 시각/주기에 자동 실행하도록 예약합니다. "매주 월요일 9시에 ...", "매일 아침 ..." 처럼 반복/예약을 요청할 때 사용하세요. schedule은 5필드 cron 표현식(분 시 일 월 요일, 한국 시간 기준)으로 변환해 넣으세요. 예: 매주 월 9시="0 9 * * 1", 매일 8시="0 8 * * *", 매시 정각="0 * * * *". 실행 간격은 최소 5분입니다. 예약 시각이 오면 request 내용이 이 채널에서 실행됩니다.',
    parameters: {
      type: 'object',
      properties: {
        schedule: {
          type: 'string',
          description: '5필드 cron 표현식 (분 시 일 월 요일). 예: "0 9 * * 1"',
        },
        request: {
          type: 'string',
          description:
            '예약 시각에 실행할 요청 내용. 예: "이번 주 일정을 정리해서 공지"',
        },
      },
      required: ['schedule', 'request'],
    },
  },
  permission: {
    // 예약 등록은 서버 관리자/매니저만(등록 권한 제한). 실행 시점의 위험 도구는 별도 승인 게이트.
    requireManageGuild: true,
    requireAdmin: false,
    risk: 'warning',
  },
  execute: async (args, context) => {
    const schedule =
      typeof args.schedule === 'string' ? args.schedule.trim() : ''
    const request = typeof args.request === 'string' ? args.request.trim() : ''
    if (schedule.length === 0 || request.length === 0) {
      return {
        success: false,
        message:
          '예약할 시각(schedule)과 실행할 요청(request)이 모두 필요해요.',
      }
    }

    const invalid = validateSchedule(schedule, TZ)
    if (invalid !== null) {
      return { success: false, message: invalid }
    }

    const nextRun = nextRunFor(schedule, TZ)
    const job = await createCronJob({
      guildId: context.guildId,
      channelId: context.channelId,
      kind: 'agent_prompt',
      schedule,
      payload: { prompt: request },
      tz: TZ,
      createdBy: context.userId,
      nextRunAt: nextRun,
    })
    if (job === null) {
      return {
        success: false,
        message:
          '예약 저장에 실패했어요 (DB 연결/마이그레이션 확인이 필요해요).',
      }
    }

    const registered = registerCronJob(job)
    if (!registered) {
      return {
        success: true,
        message: `예약을 저장했어요(id ${job.id}). 스케줄러 준비 후 활성화돼요.`,
      }
    }
    return {
      success: true,
      message: `예약을 등록했어요! (id ${job.id})\n다음 실행: ${toUnix(
        nextRun
      )}\n요청: ${request}`,
    }
  },
}

// 예약 목록 조회
export const listScheduledTasksTool: ToolDefinition = {
  declaration: {
    name: 'list_scheduled_tasks',
    description:
      '이 서버에 등록된 예약(cron) 목록을 조회합니다. 사용자가 "예약 목록", "뭐 예약돼 있어?" 등을 물을 때 사용하세요.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  permission: {
    requireManageGuild: true,
    requireAdmin: false,
    risk: 'info',
  },
  execute: async (_args, context) => {
    const jobs = await listCronJobs(context.guildId)
    if (jobs.length === 0) {
      return { success: true, message: '등록된 예약이 없어요.' }
    }
    const lines = jobs.map((j) => {
      const prompt =
        typeof j.payload.prompt === 'string' ? j.payload.prompt : ''
      const next =
        j.nextRunAt !== null
          ? `<t:${Math.floor(j.nextRunAt.getTime() / 1000)}:R>`
          : '미정'
      const state = j.enabled ? '' : ' (중지됨)'
      return `- id ${j.id}${state}: \`${j.schedule}\` (다음 ${next}) → ${prompt}`
    })
    return { success: true, message: `예약 목록:\n${lines.join('\n')}` }
  },
}

// 예약 취소(삭제)
export const cancelScheduledTaskTool: ToolDefinition = {
  declaration: {
    name: 'cancel_scheduled_task',
    description:
      '등록된 예약을 취소(삭제)합니다. list_scheduled_tasks로 확인한 id를 넣으세요.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '취소할 예약 id' },
      },
      required: ['id'],
    },
  },
  permission: {
    requireManageGuild: true,
    requireAdmin: false,
    risk: 'warning',
  },
  execute: async (args, context) => {
    const id = typeof args.id === 'number' ? args.id : Number(args.id)
    if (!Number.isFinite(id)) {
      return { success: false, message: '취소할 예약 id가 올바르지 않아요.' }
    }
    const deleted = await deleteCronJob(id, context.guildId)
    if (deleted === 0) {
      return {
        success: false,
        message: `id ${id} 예약을 찾지 못했어요(이미 취소됐거나 다른 서버의 예약일 수 있어요).`,
      }
    }
    unregisterCronJob(id)
    return { success: true, message: `id ${id} 예약을 취소했어요.` }
  },
}
