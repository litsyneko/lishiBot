import { PermissionFlagsBits } from 'discord.js'
import type { PermissionsBitField } from 'discord.js'

// AI가 대화 중 "이 사용자가 무슨 작업을 할 수 있는지" 먼저 판단하도록,
// 요청자의 핵심 관리 권한(A안)만 추려 프롬프트에 주입한다.
// 전체 권한을 다 넣으면 일반 대화 프롬프트가 무거워지므로 위험 작업 판단에 필요한 것만 담는다.

const CORE_PERMISSION_LABELS: readonly (readonly [bigint, string])[] = [
  [PermissionFlagsBits.ManageGuild, '서버 관리'],
  [PermissionFlagsBits.ManageRoles, '역할 관리'],
  [PermissionFlagsBits.ManageChannels, '채널 관리'],
  [PermissionFlagsBits.ManageMessages, '메시지 관리'],
  [PermissionFlagsBits.BanMembers, '멤버 차단'],
  [PermissionFlagsBits.KickMembers, '멤버 추방'],
  [PermissionFlagsBits.ModerateMembers, '타임아웃'],
  [PermissionFlagsBits.ManageWebhooks, '웹훅 관리'],
  [PermissionFlagsBits.ManageEvents, '이벤트 관리'],
  [PermissionFlagsBits.ManageThreads, '스레드 관리'],
  [PermissionFlagsBits.ManageNicknames, '닉네임 관리'],
]

export type PermissionSummaryOptions = {
  readonly isOwner?: boolean
}

/**
 * 요청자의 핵심 관리 권한을 한국어 한 줄로 요약한다(프롬프트 주입용).
 * - 서버 주인/관리자(Administrator)는 모든 권한 보유로 간주해 개별 나열을 생략.
 * - 그 외에는 실제로 가진 핵심 관리 권한만 나열. 하나도 없으면 "일반 유저".
 */
export function summarizeMemberPermissions(
  perms: Readonly<PermissionsBitField> | null | undefined,
  options: PermissionSummaryOptions = {}
): string {
  if (options.isOwner === true) return '서버 주인 (모든 권한 보유)'
  if (perms === null || perms === undefined) return '일반 유저 (관리 권한 없음)'
  if (perms.has(PermissionFlagsBits.Administrator)) {
    return '서버 관리자 (관리자 권한 — 모든 관리 작업 가능)'
  }
  const held = CORE_PERMISSION_LABELS.filter(([flag]) => perms.has(flag)).map(
    ([, label]) => label
  )
  if (held.length === 0) return '일반 유저 (관리 권한 없음)'
  return `보유 관리 권한: ${held.join(', ')}`
}
