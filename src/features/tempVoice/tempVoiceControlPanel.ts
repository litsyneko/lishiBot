import {
  ContainerBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from '@discordjs/builders'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js'

export const TVCTL_PREFIX = 'tvctl:'
export const TVCTL_MODAL_PREFIX = 'tvctlModal:'

export const TVCTL_ACTIONS = {
  rename: 'rename',
  status: 'status',
  limit: 'limit',
  lock: 'lock',
  transfer: 'transfer',
  kick: 'kick',
  tts: 'tts',
  // 셀렉트 제출
  transferSel: 'transferSel',
  kickSel: 'kickSel',
  kickReason: 'kickReason',
} as const

export const TVCTL_MODALS = {
  rename: 'rename',
  status: 'status',
  limit: 'limit',
  kickReason: 'kickReason',
} as const

// 내보내기 사유 프리셋 (+ 'custom'은 직접 입력).
export const KICK_REASONS = [
  { key: 'noise', label: '시끄럽거나 방해가 돼요' },
  { key: 'manner', label: '부적절한 언행/비매너' },
  { key: 'space', label: '자리 정리 (인원 조정)' },
  { key: 'personal', label: '방장 개인 사유' },
] as const

export function kickReasonLabel(key: string): string | null {
  return KICK_REASONS.find((r) => r.key === key)?.label ?? null
}

export const TVCTL_PANEL_FLAGS = MessageFlags.IsComponentsV2
const ACCENT = 0x5865f2

export type ControlPanelState = {
  readonly channelName: string
  readonly ownerId: string
  readonly locked: boolean
  readonly userLimit: number
  readonly status: string | null
  readonly ttsActive: boolean
}

function cid(action: string): string {
  return `${TVCTL_PREFIX}${action}`
}

function divider(): SeparatorBuilder {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Small)
}

function limitLabel(limit: number): string {
  return limit <= 0 ? '무제한' : `${limit}명`
}

export function buildControlPanel(state: ControlPanelState): {
  components: ContainerBuilder[]
  flags: number
} {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🔊 ${state.channelName}\n-# 통화방에 들어와 있는 방장(또는 서버 관리자)이 관리해요.`
      )
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `방장: <@${state.ownerId}>`,
          `상태: **${state.locked ? '🔒 잠금(비공개)' : '🔓 공개'}**`,
          `인원 제한: **${limitLabel(state.userLimit)}**`,
          state.status !== null && state.status.length > 0
            ? `채널 상태: ${state.status}`
            : null,
        ]
          .filter((line): line is string => line !== null)
          .join('\n')
      )
    )
    .addSeparatorComponents(divider())
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(cid(TVCTL_ACTIONS.rename))
          .setLabel('이름 변경')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(cid(TVCTL_ACTIONS.status))
          .setLabel('상태 변경')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(cid(TVCTL_ACTIONS.limit))
          .setLabel('인원 제한')
          .setStyle(ButtonStyle.Secondary)
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(cid(TVCTL_ACTIONS.lock))
          .setLabel(state.locked ? '잠금 해제' : '잠금(비공개)')
          .setStyle(state.locked ? ButtonStyle.Success : ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(cid(TVCTL_ACTIONS.transfer))
          .setLabel('방장 이전')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(cid(TVCTL_ACTIONS.tts))
          .setLabel(state.ttsActive ? '🔇 TTS 내보내기' : '🔊 TTS 부르기')
          .setStyle(
            state.ttsActive ? ButtonStyle.Danger : ButtonStyle.Secondary
          )
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(cid(TVCTL_ACTIONS.kick))
          .setLabel('내보내기')
          .setStyle(ButtonStyle.Danger)
      )
    )

  return { components: [container], flags: TVCTL_PANEL_FLAGS }
}

// ─── 모달 ───

export function buildRenameModal(current: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${TVCTL_MODAL_PREFIX}${TVCTL_MODALS.rename}`)
    .setTitle('통화방 이름 변경')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('새 이름 (최대 100자)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('value')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100)
            .setValue(current)
        )
    )
}

export function buildStatusModal(current: string | null): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${TVCTL_MODAL_PREFIX}${TVCTL_MODALS.status}`)
    .setTitle('통화방 상태 변경')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('채널 상태 문구 (비우면 삭제, 최대 500자)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('value')
            .setPlaceholder('예: 롤 한 판만 더 🎮')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(500)
            .setValue(current ?? '')
        )
    )
}

export function buildLimitModal(current: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${TVCTL_MODAL_PREFIX}${TVCTL_MODALS.limit}`)
    .setTitle('인원 제한 설정')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('최대 인원 (0=무제한, 최대 99)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('value')
            .setPlaceholder('0')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(2)
            .setValue(String(current))
        )
    )
}

// ─── 내보내기 사유 선택 / 유저 선택 (ephemeral) ───

/** 내보낼 대상(targetId)을 정한 뒤, 사유를 고르는 임시 셀렉트 메시지. */
export function buildKickReasonMessage(targetId: string): {
  content: string
  components: ActionRowBuilder<StringSelectMenuBuilder>[]
  flags: number
} {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${cid(TVCTL_ACTIONS.kickReason)}:${targetId}`)
    .setPlaceholder('내보내는 사유를 선택하세요')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      ...KICK_REASONS.map((r) => ({ label: r.label, value: r.key })),
      { label: '기타 (직접 입력)', value: 'custom' }
    )

  return {
    content: `<@${targetId}>님을 내보내는 사유를 선택하세요.`,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ],
    flags: MessageFlags.Ephemeral,
  }
}

/** '기타' 선택 시 사유를 직접 입력하는 모달. */
export function buildKickReasonModal(targetId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${TVCTL_MODAL_PREFIX}${TVCTL_MODALS.kickReason}:${targetId}`)
    .setTitle('내보내기 사유')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('내보내는 사유 (상대에게 DM으로 전달돼요)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('value')
            .setPlaceholder('예: 반복적인 방해로 내보냅니다')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(300)
        )
    )
}

/** 방장 이전/추방용 임시 유저 선택 메시지 (서버 전체 멤버 검색 가능). */
export function buildUserSelectMessage(
  action: string,
  placeholder: string
): {
  content: string
  components: ActionRowBuilder<UserSelectMenuBuilder>[]
  flags: number
} {
  const menu = new UserSelectMenuBuilder()
    .setCustomId(cid(action))
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1)

  return {
    content: placeholder,
    components: [
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(menu),
    ],
    flags: MessageFlags.Ephemeral,
  }
}
