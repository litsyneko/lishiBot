import {
  type OverwriteResolvable,
  type OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js'

/** AI 입력에서 받은 권한 문자열을 PermissionFlagsBits로 변환 */
const ALLOWED_PERMISSION_KEYS = Object.keys(
  PermissionFlagsBits
) as (keyof typeof PermissionFlagsBits)[]

export interface ParsedOverwriteInput {
  /** 역할 ID 또는 멤버 ID */
  id: string
  /** 'role' 또는 'member' (기본값 'role') */
  type?: 'role' | 'member'
  /** 허용할 권한 문자열 배열 */
  allow?: string[]
  /** 거부할 권한 문자열 배열 */
  deny?: string[]
}

export interface ResolvedOverwrite {
  id: string
  type: OverwriteType
  allow: PermissionsBitField
  deny: PermissionsBitField
}

export interface ResolveOverwritesResult {
  overwrites?: ResolvedOverwrite[]
  error?: string
}

export function permissionListForDescription(): string {
  return ALLOWED_PERMISSION_KEYS.join(', ')
}

function resolveFlagList(
  list: unknown,
  field: 'allow' | 'deny'
): { flags?: PermissionsBitField; error?: string } {
  if (list === undefined || list === null) {
    return { flags: new PermissionsBitField() }
  }
  if (!Array.isArray(list)) {
    return { error: `${field}는 문자열 배열이어야 해요.` }
  }
  const flags = new PermissionsBitField()
  for (const raw of list) {
    if (typeof raw !== 'string') {
      return { error: `${field} 배열의 각 항목은 문자열이어야 해요.` }
    }
    const key = raw.trim().toLowerCase() as keyof typeof PermissionFlagsBits
    const candidates = ALLOWED_PERMISSION_KEYS.filter(
      (k) => k.toLowerCase() === key
    )
    if (candidates.length === 0) {
      return { error: `알 수 없는 권한: ${raw}` }
    }
    flags.add(PermissionFlagsBits[candidates[0]])
  }
  return { flags }
}

/**
 * AI 입력 배열을 discord.js OverwriteResolvable[]로 변환합니다.
 * 각 항목은 { id, type?, allow?, deny? } 형태.
 */
export function resolvePermissionOverwrites(
  input: unknown
): ResolveOverwritesResult {
  if (input === undefined || input === null) {
    return { overwrites: [] }
  }
  if (!Array.isArray(input)) {
    return { error: 'permission_overwrites는 배열이어야 해요.' }
  }
  if (input.length === 0) {
    return { overwrites: [] }
  }

  const resolved: ResolvedOverwrite[] = []
  for (let i = 0; i < input.length; i++) {
    const entry = input[i] as Record<string, unknown> | null
    if (entry === null || typeof entry !== 'object') {
      return { error: `${i + 1}번째 권한 항목이 객체가 아니에요.` }
    }
    const id = (entry.id as string | undefined)?.trim()
    if (!id) {
      return { error: `${i + 1}번째 권한 항목에 id가 없어요.` }
    }
    const typeRaw = (entry.type as string | undefined)?.trim().toLowerCase()
    const type: OverwriteType =
      typeRaw === 'member' ? 1 : typeRaw === 'role' ? 0 : 0

    const allowResult = resolveFlagList(entry.allow, 'allow')
    if (allowResult.error !== undefined || allowResult.flags === undefined) {
      return { error: allowResult.error ?? 'allow 오류' }
    }
    const denyResult = resolveFlagList(entry.deny, 'deny')
    if (denyResult.error !== undefined || denyResult.flags === undefined) {
      return { error: denyResult.error ?? 'deny 오류' }
    }

    resolved.push({
      id,
      type,
      allow: allowResult.flags,
      deny: denyResult.flags,
    })
  }

  return { overwrites: resolved }
}

/** discord.js create() 호출에 바로 넘길 수 있는 형태로 변환 */
export function toCreateOverwrites(
  resolved: ResolvedOverwrite[] | undefined
): OverwriteResolvable[] | undefined {
  if (!resolved || resolved.length === 0) return undefined
  return resolved.map((o) => ({
    id: o.id,
    type: o.type,
    allow: o.allow,
    deny: o.deny,
  }))
}
