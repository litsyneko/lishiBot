import {
  ContainerBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from '@discordjs/builders'
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
  draft_embed: '임베드 초안',
  send_embed: '임베드 전송',
  edit_message: '메시지 수정',
  delete_message: '메시지 삭제',
  pin_message: '메시지 고정',
  unpin_message: '고정 해제',
  react_message: '메시지 반응',
  search_messages: '메시지 검색',
  schedule_task: '작업 예약',
  list_scheduled_tasks: '예약 목록',
  cancel_scheduled_task: '예약 취소',
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
    return `\`${key}\`: ${formatted}`
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

// ─── 승인 카드 (Components V2 컨테이너 = 임베드 룩) ───

// 결정 전은 위험(빨강), 승인 후는 성공(초록), 그 외 종료(거부/만료/실패)는 중립(회색).
const ACCENT_PENDING = 0xed4245
const ACCENT_APPROVED = 0x57f287
const ACCENT_NEUTRAL = 0x99aab5
// 권한 요구 카드 전용 커스텀 이모지(리시 지정).
const KAWAII_CAUTION = '<:kawaiicaution:1521755658792206366>'

function divider(): SeparatorBuilder {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Small)
}

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
    `${KAWAII_CAUTION} **승인이 필요한 작업**`,
    'AI가 위험 작업을 실행하려고 해요. 아래 내용을 확인하고 결정해 주세요.',
    '',
    `**작업** · ${displayName}`,
    '',
    '**세부 내용**',
    formatArgsForEmbed(args),
    '',
    `-# ${deciderLine}`,
  ].join('\n')
}

export type ApprovalCardInput = {
  readonly toolName: string
  readonly args: Record<string, unknown>
  readonly requesterId: string
  readonly proposalId: string
  readonly dangerGate: 'admin_only' | 'requester' | 'none'
}

/** 위험 도구 제안을 사용자에게 보여주는 컨테이너 승인 카드([실행 승인]/[거부] 버튼 포함). */
export function buildApprovalCard(input: ApprovalCardInput): {
  components: ContainerBuilder[]
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

  const container = new ContainerBuilder()
    .setAccentColor(ACCENT_PENDING)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        approvalCardBody(
          input.toolName,
          input.args,
          input.requesterId,
          input.dangerGate
        )
      )
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '-# ⏳ 5분 안에 결정하지 않으면 만료돼요.'
      )
    )
    .addActionRowComponents(buttons)

  return {
    components: [container],
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
  components: ContainerBuilder[]
  flags: number
} {
  // 승인(✅)은 성공색, 나머지 종료(거부/만료/실패)는 중립색으로 시각 구분.
  const accent = input.statusLine.includes('✅')
    ? ACCENT_APPROVED
    : ACCENT_NEUTRAL

  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        approvalCardBody(
          input.toolName,
          input.args,
          input.requesterId,
          input.dangerGate
        )
      )
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(input.statusLine)
    )

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  }
}
