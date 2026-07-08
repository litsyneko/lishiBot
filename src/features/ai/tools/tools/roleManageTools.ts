import { resolveGuild } from '../helpers/resolveGuild'
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../toolTypes'
import {
  Client,
  PermissionFlagsBits,
  PermissionsBitField,
  type Role,
} from 'discord.js'

const MAX_ROLE_NAME_LENGTH = 100

/** 허용하는 색상 표현: #RRGGBB, #RGB, 정수 문자열 */
const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** 일반적인 색상 이름 → HEX (AI가 자주 쓰는 표현) */
const COLOR_NAMES: Record<string, number> = {
  빨강: 0xe74c3c,
  레드: 0xe74c3c,
  red: 0xe74c3c,
  주황: 0xe67e22,
  오렌지: 0xe67e22,
  orange: 0xe67e22,
  노랑: 0xf1c40f,
  옐로우: 0xf1c40f,
  yellow: 0xf1c40f,
  초록: 0x2ecc71,
  그린: 0x2ecc71,
  green: 0x2ecc71,
  파랑: 0x3498db,
  블루: 0x3498db,
  blue: 0x3498db,
  보라: 0x9b59b6,
  퍼플: 0x9b59b6,
  purple: 0x9b59b6,
  핑크: 0xffc0cb,
  pink: 0xffc0cb,
  검정: 0x000000,
  블랙: 0x000000,
  black: 0x000000,
  흰색: 0xffffff,
  화이트: 0xffffff,
  white: 0xffffff,
  회색: 0x95a5a6,
  그레이: 0x95a5a6,
  gray: 0x95a5a6,
  grey: 0x95a5a6,
}

function resolveColor(input: string | undefined): number | null {
  if (!input) return null
  const trimmed = input.trim()
  const named = COLOR_NAMES[trimmed.toLowerCase()]
  if (named !== undefined) return named
  if (HEX_COLOR_PATTERN.test(trimmed)) {
    return parseInt(trimmed.slice(1), 16)
  }
  const asInt = Number(trimmed)
  if (Number.isInteger(asInt) && asInt >= 0 && asInt <= 0xffffff) {
    return asInt
  }
  return null
}

/** 디스코드 권한 문자열 이름 리스트 (AI가 잘 아는 주요 권한들) */
const ALLOWED_PERMISSION_KEYS = Object.keys(
  PermissionFlagsBits
) as (keyof typeof PermissionFlagsBits)[]

function resolvePermissionFlags(perms: unknown): {
  flags?: PermissionsBitField
  error?: string
} {
  if (!Array.isArray(perms)) {
    return { error: 'permissions는 문자열 배열이어야 해요.' }
  }
  const resolved = new PermissionsBitField()
  for (const raw of perms) {
    if (typeof raw !== 'string') {
      return { error: 'permissions 배열의 각 항목은 문자열이어야 해요.' }
    }
    const key = raw.trim().toLowerCase() as keyof typeof PermissionFlagsBits
    const candidates = ALLOWED_PERMISSION_KEYS.filter(
      (k) => k.toLowerCase() === key
    )
    if (candidates.length === 0) {
      return { error: `알 수 없는 권한: ${raw}` }
    }
    resolved.add(PermissionFlagsBits[candidates[0]])
  }
  return { flags: resolved }
}

function permissionList(): string {
  return ALLOWED_PERMISSION_KEYS.join(', ')
}

function assertBotCanManageRole(
  role: Role,
  botMember: Role['guild']['members']['me']
): string | null {
  if (role.id === role.guild.id) {
    return '@everyone 역할은 수정/삭제할 수 없어요.'
  }
  if (role.managed) {
    return `${role.name}은(는) 연동/봇 전용 역할이라 변경할 수 없어요.`
  }
  if (
    botMember !== null &&
    botMember.roles.highest.comparePositionTo(role) <= 0
  ) {
    return '리시보다 높거나 같은 위치의 역할은 변경할 수 없어요.'
  }
  return null
}

async function fetchRole(
  client: Client,
  context: ToolExecutionContext,
  roleId: string | undefined,
  roleName: string | undefined
): Promise<{ role?: Role; error?: string }> {
  if (!roleId && !roleName) {
    return { error: 'role_id 또는 role_name 중 하나는 필요해요.' }
  }
  const guild = await resolveGuild(client, context)
  let role: Role | undefined
  if (roleId) {
    role = guild.roles.cache.get(roleId)
  }
  if (!role && roleName) {
    const lower = roleName.toLowerCase()
    role = guild.roles.cache.find((r) => r.name.toLowerCase() === lower)
  }
  if (!role) {
    return { error: '해당 역할을 찾을 수 없어요.' }
  }
  return { role }
}

// ─── create_role ───

export function createRoleTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'create_role',
      description:
        '서버에 새 역할을 만듭니다. 이름/색상/표시(hoist)/멘션 가능(mentionable)을 지정할 수 있어요.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: `역할 이름 (최대 ${MAX_ROLE_NAME_LENGTH}자)`,
          },
          color: {
            type: 'string',
            description:
              '역할 색상. 예: "#ff0000", "빨강", "red", 또는 정수. (선택)',
          },
          hoist: {
            type: 'boolean',
            description: 'true면 멤버 목록에서 역할별로 따로 표시 (선택)',
          },
          mentionable: {
            type: 'boolean',
            description: 'true면 @멘션 가능 (선택)',
          },
          reason: {
            type: 'string',
            description: '사유 (선택)',
          },
        },
        required: ['name'],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'danger',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const name = (args.name as string | undefined)?.trim()
        if (!name) {
          return { success: false, message: '역할 이름을 입력해 주세요.' }
        }
        if (name.length > MAX_ROLE_NAME_LENGTH) {
          return {
            success: false,
            message: `역할 이름은 ${MAX_ROLE_NAME_LENGTH}자 이내여야 해요.`,
          }
        }

        const colorInput = args.color as string | undefined
        const color = colorInput ? resolveColor(colorInput) : null
        if (colorInput && color === null) {
          return {
            success: false,
            message: `색상 값을 인식할 수 없어요: "${colorInput}"`,
          }
        }
        const hoist = args.hoist as boolean | undefined
        const mentionable = args.mentionable as boolean | undefined
        const reason =
          (args.reason as string | undefined)?.trim() ?? 'AI 리시가 생성'

        const guild = await resolveGuild(client, context)
        const role = await guild.roles.create({
          name,
          color: color ?? undefined,
          hoist: hoist ?? false,
          mentionable: mentionable ?? false,
          reason,
        })

        const summary = `새 역할 **${role.name}** (ID: \`${role.id}\`)을(를) 만들었어요.`
        return {
          success: true,
          message: summary,
          summary,
          data: {
            roleId: role.id,
            name: role.name,
            color: role.hexColor,
            hoist: role.hoist,
            mentionable: role.mentionable,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `역할 생성 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── delete_role ───

export function deleteRoleTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'delete_role',
      description:
        '서버에서 역할을 삭제합니다. @everyone, 관리 역할, 리시보다 높은 역할은 삭제할 수 없어요.',
      parameters: {
        type: 'object',
        properties: {
          role_id: {
            type: 'string',
            description: '삭제할 역할 ID (role_name이 없을 때 필요)',
          },
          role_name: {
            type: 'string',
            description: '삭제할 역할 이름 (role_id가 없을 때 사용)',
          },
          reason: {
            type: 'string',
            description: '사유 (선택)',
          },
        },
        required: [],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'danger',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const roleId = (args.role_id as string | undefined)?.trim() || undefined
        const roleName =
          (args.role_name as string | undefined)?.trim() || undefined
        const reason =
          (args.reason as string | undefined)?.trim() ?? 'AI 리시가 삭제'

        const { role, error } = await fetchRole(
          client,
          context,
          roleId,
          roleName
        )
        if (error !== undefined || role === undefined) {
          return { success: false, message: error ?? '역할 오류' }
        }

        const block = assertBotCanManageRole(role, role.guild.members.me)
        if (block !== null) {
          return { success: false, message: block }
        }

        const snapshot = { id: role.id, name: role.name }
        await role.delete(reason)

        const summary = `역할 **${snapshot.name}** (ID: \`${snapshot.id}\`)을(를) 삭제했어요.`
        return {
          success: true,
          message: summary,
          summary,
          data: snapshot,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `역할 삭제 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── edit_role ───

export function editRoleTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'edit_role',
      description:
        '역할의 이름/색상/표시(hoist)/멘션 가능(mentionable)을 수정합니다. 지정하지 않은 항목은 그대로 유지돼요.',
      parameters: {
        type: 'object',
        properties: {
          role_id: {
            type: 'string',
            description: '수정할 역할 ID (role_name이 없을 때 필요)',
          },
          role_name: {
            type: 'string',
            description: '수정할 역할 이름 (role_id가 없을 때 사용)',
          },
          new_name: {
            type: 'string',
            description: `새 역할 이름 (최대 ${MAX_ROLE_NAME_LENGTH}자)`,
          },
          color: {
            type: 'string',
            description:
              '새 색상. 예: "#00ff00", "초록", "green", 또는 정수. 빈 문자열이면 기본 색상(검정)으로 초기화.',
          },
          hoist: {
            type: 'boolean',
            description: 'true면 멤버 목록에서 역할별로 따로 표시',
          },
          mentionable: {
            type: 'boolean',
            description: 'true면 @멘션 가능',
          },
          reason: {
            type: 'string',
            description: '사유 (선택)',
          },
        },
        required: [],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'danger',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const roleId = (args.role_id as string | undefined)?.trim() || undefined
        const roleName =
          (args.role_name as string | undefined)?.trim() || undefined

        const { role, error } = await fetchRole(
          client,
          context,
          roleId,
          roleName
        )
        if (error !== undefined || role === undefined) {
          return { success: false, message: error ?? '역할 오류' }
        }

        const block = assertBotCanManageRole(role, role.guild.members.me)
        if (block !== null) {
          return { success: false, message: block }
        }

        const newName = (args.new_name as string | undefined)?.trim()
        if (newName !== undefined && newName.length > MAX_ROLE_NAME_LENGTH) {
          return {
            success: false,
            message: `역할 이름은 ${MAX_ROLE_NAME_LENGTH}자 이내여야 해요.`,
          }
        }

        const colorInput = args.color as string | undefined
        let color: number | null | undefined = undefined
        if (colorInput !== undefined) {
          if (colorInput.trim() === '') {
            color = 0
          } else {
            color = resolveColor(colorInput)
            if (color === null) {
              return {
                success: false,
                message: `색상 값을 인식할 수 없어요: "${colorInput}"`,
              }
            }
          }
        }

        const hoist = args.hoist as boolean | undefined
        const mentionable = args.mentionable as boolean | undefined
        const reason =
          (args.reason as string | undefined)?.trim() ?? 'AI 리시가 수정'

        await role.edit({
          name: newName ?? undefined,
          color: color ?? undefined,
          hoist: hoist ?? undefined,
          mentionable: mentionable ?? undefined,
          reason,
        })

        const changes: string[] = []
        if (newName) changes.push(`이름 → **${newName}**`)
        if (color !== undefined) changes.push(`색상 → **${role.hexColor}**`)
        if (hoist !== undefined)
          changes.push(`표시 → ${hoist ? '켜짐' : '꺼짐'}`)
        if (mentionable !== undefined)
          changes.push(`멘션 → ${mentionable ? '켜짐' : '꺼짐'}`)

        const summary =
          changes.length === 0
            ? `**${role.name}** 역할을 조회했어요 (변경 사항 없음).`
            : `**${role.name}** 역할 수정: ${changes.join(', ')}`
        return {
          success: true,
          message: summary,
          summary,
          data: {
            roleId: role.id,
            name: role.name,
            color: role.hexColor,
            hoist: role.hoist,
            mentionable: role.mentionable,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `역할 수정 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── set_role_permissions ───

export function setRolePermissionsTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'set_role_permissions',
      description:
        '역할의 디스코드 권한(permissions)을 변경합니다. 기존 권한을 완전히 교체해요. @everyone, 관리 역할, 리시보다 높은 역할은 제외돼요. 위험한 작업이라 관리자 전용이에요.',
      parameters: {
        type: 'object',
        properties: {
          role_id: {
            type: 'string',
            description: '권한을 변경할 역할 ID (role_name이 없을 때 필요)',
          },
          role_name: {
            type: 'string',
            description: '권한을 변경할 역할 이름 (role_id가 없을 때 사용)',
          },
          permissions: {
            type: 'array',
            items: { type: 'string', description: '권한 이름' },
            description: `설정할 권한 문자열 배열. 예: ["SendMessages", "ViewChannel"]. 전체 목록: ${permissionList()}`,
          },
          reason: {
            type: 'string',
            description: '사유 (선택)',
          },
        },
        required: ['permissions'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: true,
      risk: 'danger',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const roleId = (args.role_id as string | undefined)?.trim() || undefined
        const roleName =
          (args.role_name as string | undefined)?.trim() || undefined

        const { role, error } = await fetchRole(
          client,
          context,
          roleId,
          roleName
        )
        if (error !== undefined || role === undefined) {
          return { success: false, message: error ?? '역할 오류' }
        }

        const block = assertBotCanManageRole(role, role.guild.members.me)
        if (block !== null) {
          return { success: false, message: block }
        }

        const { flags, error: permError } = resolvePermissionFlags(
          args.permissions
        )
        if (permError !== undefined || flags === undefined) {
          return { success: false, message: permError ?? '권한 오류' }
        }

        const previous = role.permissions.toArray()
        const reason =
          (args.reason as string | undefined)?.trim() ?? 'AI 리시가 권한 변경'

        await role.setPermissions(flags, reason)

        const next = role.permissions.toArray()
        const summary = `**${role.name}** 역할 권한을 ${next.length}개로 변경했어요.`
        return {
          success: true,
          message: summary,
          summary,
          data: {
            roleId: role.id,
            previous,
            current: next,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `권한 변경 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}

// ─── reorder_role ───

export function reorderRoleTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'reorder_role',
      description:
        '역할의 위치(position)를 변경해 권한 계층을 조정합니다. position이 클수록 위에 있어요. @everyone, 관리 역할, 리시보다 높거나 같은 역할은 이동할 수 없고, 리시 최상위 역할보다 위로 올릴 수도 없어요. 위험한 작업이라 관리자 전용이에요.',
      parameters: {
        type: 'object',
        properties: {
          role_id: {
            type: 'string',
            description: '이동할 역할 ID (role_name이 없을 때 필요)',
          },
          role_name: {
            type: 'string',
            description: '이동할 역할 이름 (role_id가 없을 때 사용)',
          },
          position: {
            type: 'integer',
            description: '새 위치(1 이상 정수). 클수록 권한 위.',
          },
          reason: {
            type: 'string',
            description: '사유 (선택)',
          },
        },
        required: ['position'],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: true,
      risk: 'danger',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext
    ): Promise<ToolResult> {
      try {
        const roleId = (args.role_id as string | undefined)?.trim() || undefined
        const roleName =
          (args.role_name as string | undefined)?.trim() || undefined
        const position = Number(args.position)
        const reason =
          (args.reason as string | undefined)?.trim() ?? 'AI 리시가 순서 변경'

        if (!Number.isInteger(position) || position < 1) {
          return {
            success: false,
            message: 'position은 1 이상의 정수여야 해요.',
          }
        }

        const { role, error } = await fetchRole(
          client,
          context,
          roleId,
          roleName
        )
        if (error !== undefined || role === undefined) {
          return { success: false, message: error ?? '역할 오류' }
        }

        const botMember = role.guild.members.me
        const block = assertBotCanManageRole(role, botMember)
        if (block !== null) {
          return { success: false, message: block }
        }
        if (
          botMember !== null &&
          position >= botMember.roles.highest.position
        ) {
          return {
            success: false,
            message: '리시 최상위 역할보다 높은 위치로는 옮길 수 없어요.',
          }
        }

        const previous = role.position
        await role.setPosition(position, { reason })

        const summary = `**${role.name}** 역할 위치를 ${previous} → ${role.position}(으)로 변경했어요.`
        return {
          success: true,
          message: summary,
          summary,
          data: {
            roleId: role.id,
            previous,
            current: role.position,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message: `역할 순서 변경 중 오류가 발생했어요: ${message}`,
        }
      }
    },
  }
}
