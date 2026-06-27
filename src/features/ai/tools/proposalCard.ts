import type { ProposalInfo } from './toolTypes'
import { Colors, EmbedBuilder } from 'discord.js'

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
  list_roles: '역할 목록',
  lookup_role: '역할 조회',
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
  get_sticker: '스티커 조회',
  send_sticker: '스티커 전송',
  send_message: '메시지 전송',
}

const severityColor: Record<ProposalInfo['severity'], number> = {
  info: Colors.Blue,
  warning: Colors.Yellow,
  danger: Colors.Red,
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

/**
 * Builds a discord.js EmbedBuilder that presents an AI tool proposal
 * to the user for confirmation.
 *
 * @param proposal - The proposed tool action details.
 * @returns An EmbedBuilder configured with severity-appropriate styling.
 */
export function buildProposalEmbed(proposal: ProposalInfo): EmbedBuilder {
  const displayName = toolNameMap[proposal.toolName] ?? proposal.toolName

  return new EmbedBuilder()
    .setTitle('🛠️ 제안된 작업')
    .setDescription(proposal.description)
    .addFields(
      { name: '작업', value: displayName, inline: false },
      {
        name: '세부 내용',
        value: formatArgsForEmbed(proposal.args),
        inline: false,
      }
    )
    .setColor(severityColor[proposal.severity])
    .setFooter({
      text: "이 작업을 진행할까요? '네' 또는 '아니요'로 답변해 주세요.",
    })
}
