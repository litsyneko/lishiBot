import {
  type TempVoiceSettings,
  applyTempVoiceSettings,
  getTempVoiceSettings,
} from '../../../tempVoice/tempVoiceSettings'
import { resolveGuild } from '../helpers/resolveGuild'
import type { ToolDefinition, ToolResult } from '../toolTypes'
import { ChannelType, type Client } from 'discord.js'

// AI가 임시 통화방(자동 생성) 기능을 조회/설정하는 도구.
// requireManageGuild: true → 서버 관리 권한이 있는 요청자에게만 노출된다.
export function configureTempVoiceTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'configure_temp_voice',
      description:
        '임시 통화방(Join-to-Create) 기능을 조회하거나 설정한다. ' +
        'action="view"면 현재 설정을 알려주고, action="update"면 전달된 항목만 바꾼다. ' +
        '생성 채널(generator_channel_id)에 유저가 입장하면 개인 통화방이 자동으로 만들어진다. ' +
        '생성 채널을 지정하면 enabled를 명시하지 않는 한 기능이 자동으로 켜진다. ' +
        '채널/카테고리는 반드시 실제 ID로 전달해야 한다(이름이면 먼저 lookup_channel로 ID를 찾을 것).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: '"view"(현재 설정 조회) 또는 "update"(설정 변경)',
            enum: ['view', 'update'],
          },
          enabled: {
            type: 'boolean',
            description: '기능 켜기(true)/끄기(false)',
          },
          generator_channel_id: {
            type: 'string',
            description:
              '통화방 생성용 음성 채널 ID. 이 채널에 입장하면 통화방이 만들어진다.',
          },
          category_id: {
            type: 'string',
            description:
              '통화방이 생성될 카테고리 ID. "none"이면 생성 채널과 같은 위치에 만든다.',
          },
          log_channel_id: {
            type: 'string',
            description:
              '통화방 생성·삭제·방장이전·내보내기 로그를 남길 텍스트 채널 ID. "none"이면 로그 끔.',
          },
          name_template: {
            type: 'string',
            description: '통화방 이름 템플릿. {user}=닉네임, {count}=순번.',
          },
          default_user_limit: {
            type: 'number',
            description: '통화방 기본 인원 제한(0~99, 0=무제한).',
          },
          owner_grace_minutes: {
            type: 'number',
            description:
              '방장이 나간 뒤 자동 위임까지의 유예(분). 0=즉시, 보통 10/20/30.',
          },
          cooldown_seconds: {
            type: 'number',
            description:
              '같은 사람의 연속 통화방 생성을 막는 쿨다운(초, 0~600).',
          },
        },
        required: ['action'],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'warning',
    },
    execute: async (args, context): Promise<ToolResult> => {
      try {
        const guild = await resolveGuild(client, context)
        const action = typeof args.action === 'string' ? args.action : 'view'

        if (action === 'view') {
          const current = await getTempVoiceSettings(context.guildId)
          return {
            success: true,
            message: formatSettings(current),
            data: toData(current),
          }
        }

        const patch: {
          enabled?: boolean
          generatorChannelId?: string | null
          categoryId?: string | null
          logChannelId?: string | null
          nameTemplate?: string
          defaultUserLimit?: number
          ownerGraceMinutes?: number
          cooldownSeconds?: number
        } = {}
        const changes: string[] = []

        // 생성 채널
        if (typeof args.generator_channel_id === 'string') {
          const id = args.generator_channel_id.trim()
          const channel = guild.channels.cache.get(id)
          if (
            channel === undefined ||
            channel.type !== ChannelType.GuildVoice
          ) {
            return {
              success: false,
              message:
                '생성 채널은 유효한 음성 채널 ID여야 해요. lookup_channel로 먼저 ID를 확인해 주세요.',
            }
          }
          patch.generatorChannelId = id
          changes.push(`생성 채널 → #${channel.name}`)
        }

        // 카테고리 ("none"이면 해제)
        if (typeof args.category_id === 'string') {
          const raw = args.category_id.trim()
          if (raw === '' || raw.toLowerCase() === 'none') {
            patch.categoryId = null
            changes.push('카테고리 → 생성 채널과 동일')
          } else {
            const category = guild.channels.cache.get(raw)
            if (
              category === undefined ||
              category.type !== ChannelType.GuildCategory
            ) {
              return {
                success: false,
                message: '카테고리는 유효한 카테고리 채널 ID여야 해요.',
              }
            }
            patch.categoryId = raw
            changes.push(`카테고리 → ${category.name}`)
          }
        }

        // 로그 채널 ("none"이면 해제)
        if (typeof args.log_channel_id === 'string') {
          const raw = args.log_channel_id.trim()
          if (raw === '' || raw.toLowerCase() === 'none') {
            patch.logChannelId = null
            changes.push('로그 채널 → 끔')
          } else {
            const logCh = guild.channels.cache.get(raw)
            if (
              logCh === undefined ||
              (logCh.type !== ChannelType.GuildText &&
                logCh.type !== ChannelType.GuildAnnouncement)
            ) {
              return {
                success: false,
                message: '로그 채널은 유효한 텍스트 채널 ID여야 해요.',
              }
            }
            patch.logChannelId = raw
            changes.push(`로그 채널 → #${logCh.name}`)
          }
        }

        // enabled (명시 시 우선)
        const enabled = coerceBoolean(args.enabled)
        if (enabled !== null) {
          patch.enabled = enabled
          changes.push(enabled ? '기능 켜짐' : '기능 꺼짐')
        } else if (patch.generatorChannelId !== undefined) {
          // 생성 채널을 새로 지정하면 자동으로 켠다.
          patch.enabled = true
          changes.push('기능 켜짐(자동)')
        }

        if (typeof args.name_template === 'string') {
          const template = args.name_template.trim()
          if (template.length > 0) {
            patch.nameTemplate = template.slice(0, 80)
            changes.push(`이름 템플릿 → ${patch.nameTemplate}`)
          }
        }

        const limit = coerceInt(args.default_user_limit, 0, 99)
        if (limit !== null) {
          patch.defaultUserLimit = limit
          changes.push(`기본 인원 → ${limit === 0 ? '무제한' : `${limit}명`}`)
        }

        const grace = coerceInt(args.owner_grace_minutes, 0, 120)
        if (grace !== null) {
          patch.ownerGraceMinutes = grace
          changes.push(`자동 위임 → ${grace === 0 ? '즉시' : `${grace}분`}`)
        }

        const cooldown = coerceInt(args.cooldown_seconds, 0, 600)
        if (cooldown !== null) {
          patch.cooldownSeconds = cooldown
          changes.push(`쿨다운 → ${cooldown}초`)
        }

        if (changes.length === 0) {
          return {
            success: false,
            message:
              '변경할 항목이 없어요. 생성 채널, 카테고리, 인원, 유예 시간 등 바꿀 값을 알려주세요.',
          }
        }

        const updated = await applyTempVoiceSettings(context.guildId, patch)

        // 켜져 있는데 생성 채널이 없으면 경고를 덧붙인다.
        const warning =
          updated.enabled && updated.generatorChannelId === null
            ? ' (⚠️ 아직 생성 채널이 지정되지 않아 통화방이 만들어지지 않아요.)'
            : ''

        return {
          success: true,
          message: `임시 통화방 설정을 변경했어요.\n- ${changes.join(
            '\n- '
          )}${warning}`,
          data: toData(updated),
          summary: '임시 통화방 설정 변경',
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `통화방 설정 처리 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

function formatSettings(s: TempVoiceSettings): string {
  const lines = [
    '현재 임시 통화방 설정이에요.',
    `- 상태: ${s.enabled ? '활성화' : '비활성화'}`,
    `- 생성 채널: ${
      s.generatorChannelId !== null ? `<#${s.generatorChannelId}>` : '미지정'
    }`,
    `- 카테고리: ${
      s.categoryId !== null ? `<#${s.categoryId}>` : '생성 채널과 동일'
    }`,
    `- 로그 채널: ${
      s.logChannelId !== null ? `<#${s.logChannelId}>` : '미설정'
    }`,
    `- 이름 템플릿: ${s.nameTemplate}`,
    `- 기본 인원: ${
      s.defaultUserLimit === 0 ? '무제한' : `${s.defaultUserLimit}명`
    }`,
    `- 방장 자동 위임: ${
      s.ownerGraceMinutes === 0 ? '즉시' : `${s.ownerGraceMinutes}분`
    }`,
    `- 연속 생성 쿨다운: ${s.cooldownSeconds}초`,
  ]
  return lines.join('\n')
}

function toData(s: TempVoiceSettings): Record<string, unknown> {
  return {
    enabled: s.enabled,
    generatorChannelId: s.generatorChannelId,
    categoryId: s.categoryId,
    logChannelId: s.logChannelId,
    nameTemplate: s.nameTemplate,
    defaultUserLimit: s.defaultUserLimit,
    ownerGraceMinutes: s.ownerGraceMinutes,
    cooldownSeconds: s.cooldownSeconds,
  }
}

function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '켜기' || v === 'on' || v === '활성화')
      return true
    if (v === 'false' || v === '끄기' || v === 'off' || v === '비활성화') {
      return false
    }
  }
  return null
}

function coerceInt(value: unknown, min: number, max: number): number | null {
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && value.trim().length > 0) {
    n = Number.parseInt(value.trim(), 10)
  } else return null
  if (!Number.isFinite(n)) return null
  return Math.max(min, Math.min(max, Math.trunc(n)))
}
