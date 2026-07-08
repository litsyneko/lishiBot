import { SeparatorBuilder, TextDisplayBuilder } from '@discordjs/builders'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SeparatorSpacingSize,
} from 'discord.js'

export const toolNameMap: Record<string, string> = {
  create_channel: '채널 생성',
  delete_channel: '채널 삭제',
  edit_channel: '채널 수정',
  edit_thread: '스레드 수정',
  list_channels: '채널 목록',
  lookup_channel: '채널 조회',
  get_server_info: '서버 정보',
  lookup_member: '멤버 조회',
  voice_member_lookup: '음성 멤버 조회',
  voice_action: '음성 채널 제어',
  timeout_member: '멤버 타임아웃',
  remove_timeout: '타임아웃 해제',
  ban_member: '멤버 차단',
  unban_member: '차단 해제',
  kick_member: '멤버 추방',
  add_role_member: '역할 부여',
  remove_role_member: '역할 제거',
  set_nickname: '닉네임 변경',
  reset_nickname: '닉네임 초기화',
  list_roles: '역할 목록',
  lookup_role: '역할 조회',
  create_role: '역할 생성',
  delete_role: '역할 삭제',
  edit_role: '역할 수정',
  set_role_permissions: '역할 권한 변경',
  reorder_role: '역할 순서 변경',
  move_all_members: '음성 채널 일괄 이동',
  disconnect_all_members: '음성 채널 일괄 연결 해제',
  list_category_channels: '카테고리 채널 조회',
  reorder_category_channels: '채널 순서 변경',
  create_category: '카테고리 생성',
  delete_category: '카테고리 삭제',
  save_memory: '기억 저장',
  play_music: '음악 재생',
  stop_music: '음악 정지',
  pause_music: '음악 일시정지',
  resume_music: '음악 다시재생',
  set_volume: '볼륨 설정',
  shuffle_queue: '대기열 셔플',
  search_music: '음악 검색',
  get_music_state: '음악 상태 확인',
  seek_music: '곡 탐색',
  skip_track: '곡 건너뛰기',
  remove_from_queue: '대기열 곡 제거',
  clear_queue: '대기열 비우기',
  read_channel_messages: '채널 메시지 읽기',
  read_thread_messages: '스레드 메시지 읽기',
  list_forum_posts: '포럼 게시글 목록',
  read_forum_post: '포럼 게시글 읽기',
  create_forum: '포럼 생성',
  get_sticker: '스티커 조회',
  send_sticker: '스티커 전송',
  send_message: '메시지 전송',
}

/**
 * Formats a record of arguments into a human-readable Korean string.
 * Each key-value pair becomes "키: 값" on its own line.
 */
export function formatArgsForEmbed(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return '없음'
  const lines = entries.map(([key, value]) => {
    const formatted =
      typeof value === 'object' && value !== null
        ? JSON.stringify(value)
        : String(value)
    return `${key}: ${formatted}`
  })
  const result = lines.join('\n')
  return result.length > 1024 ? `${result.slice(0, 1021)}...` : result
}

// ─── 승인 카드 버튼 customId ───

const APPROVAL_CUSTOM_ID_PREFIX = 'aiApproval'

export function buildApprovalCustomId(
  action: 'approve' | 'deny',
  proposalId: string
): string {
  return `${APPROVAL_CUSTOM_ID_PREFIX}:${action}:${proposalId}`
}

export function parseApprovalCustomId(
  customId: string
): { action: 'approve' | 'deny'; proposalId: string } | undefined {
  if (!customId.startsWith(`${APPROVAL_CUSTOM_ID_PREFIX}:`)) return undefined
  const [, action, proposalId] = customId.split(':')
  if (action !== 'approve' && action !== 'deny') return undefined
  if (proposalId === undefined || proposalId.length === 0) return undefined
  return { action, proposalId }
}

// ─── 승인 카드 (Components V2) ───

function approvalCardBody(
  toolName: string,
  args: Record<string, unknown>,
  requesterId: string,
  dangerGate: 'admin_only' | 'requester' | 'none'
): string {
  const displayName = toolNameMap[toolName] ?? toolName
  // 결정 주체 문구는 서버 승인 정책과 일치해야 한다(admin_only=관리자, 그 외=요청자).
  const deciderLine =
    dangerGate === 'admin_only'
      ? `관리자만 승인하거나 거부할 수 있어요. (요청자: <@${requesterId}>)`
      : `요청자(<@${requesterId}>)만 결정할 수 있어요.`
  return [
    '⚠️ **승인이 필요한 작업**',
    `AI가 위험 작업을 실행하려고 해요. ${deciderLine}`,
    '',
    `**작업**: ${displayName}`,
    '**세부 내용**',
    formatArgsForEmbed(args),
  ].join('\n')
}

export type ApprovalCardInput = {
  readonly toolName: string
  readonly args: Record<string, unknown>
  readonly requesterId: string
  readonly proposalId: string
  readonly dangerGate: 'admin_only' | 'requester' | 'none'
}

/** 위험 도구 제안을 사용자에게 보여주는 Components V2 승인 카드([실행 승인]/[거부] 버튼 포함). */
export function buildApprovalCard(input: ApprovalCardInput): {
  components: (
    | TextDisplayBuilder
    | SeparatorBuilder
    | ActionRowBuilder<ButtonBuilder>
  )[]
  flags: number
} {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildApprovalCustomId('approve', input.proposalId))
      .setLabel('실행 승인')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(buildApprovalCustomId('deny', input.proposalId))
      .setLabel('거부')
      .setStyle(ButtonStyle.Secondary)
  )

  return {
    components: [
      new TextDisplayBuilder().setContent(
        approvalCardBody(
          input.toolName,
          input.args,
          input.requesterId,
          input.dangerGate
        )
      ),
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
      new TextDisplayBuilder().setContent(
        '-# 5분 안에 결정하지 않으면 만료돼요.'
      ),
      buttons,
    ],
    flags: MessageFlags.IsComponentsV2,
  }
}

export type ResolvedApprovalCardInput = {
  readonly toolName: string
  readonly args: Record<string, unknown>
  readonly requesterId: string
  readonly statusLine: string
  readonly dangerGate: 'admin_only' | 'requester' | 'none'
}

/** 결정이 끝난 승인 카드 — 버튼을 제거하고 처리 결과 상태줄로 치환한다. */
export function buildResolvedApprovalCard(input: ResolvedApprovalCardInput): {
  components: (TextDisplayBuilder | SeparatorBuilder)[]
  flags: number
} {
  return {
    components: [
      new TextDisplayBuilder().setContent(
        approvalCardBody(
          input.toolName,
          input.args,
          input.requesterId,
          input.dangerGate
        )
      ),
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
      new TextDisplayBuilder().setContent(input.statusLine),
    ],
    flags: MessageFlags.IsComponentsV2,
  }
}
