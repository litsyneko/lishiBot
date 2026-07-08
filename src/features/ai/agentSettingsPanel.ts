import type { ApprovalPolicy, HeartbeatConfig } from './serverProfile'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'

// `/에이전트 셋업` 패널. 에이전트에게 정체성(소울)과 서버 이해를 심어주는 곳.
// 각 조작은 즉시 적용 → interaction.update로 패널을 다시 그린다(관리로그 패널과 같은 관례).

export const AGENT_CFG_PREFIX = 'agentcfg:'
export const AGENT_CFG_MODAL_PREFIX = 'agentcfgModal:'

export const AGENT_CFG_ACTIONS = {
  policy: 'policy',
  hbToggle: 'hbToggle',
  hbChannel: 'hbChannel',
  soulEdit: 'soulEdit',
  conceptEdit: 'conceptEdit',
  orderAdd: 'orderAdd',
  orderClear: 'orderClear',
  roleChannel: 'roleChannel',
  roleEdit: 'roleEdit',
  roleRemove: 'roleRemove',
  sessionClear: 'sessionClear',
  refresh: 'refresh',
} as const

const ACCENT_NORMAL = 0x5865f2 // blurple
const ACCENT_WARN = 0xf39c12 // 승인 정책 none(즉시 실행)일 때 경고색

export const DANGER_GATE_LABELS: Record<ApprovalPolicy['dangerGate'], string> =
  {
    admin_only: '관리자만 승인',
    requester: '요청자 본인 승인',
    none: '승인 없이 즉시 실행',
  }

export type AgentPanelData = {
  readonly soul: string | null
  readonly concept: string | null
  readonly dangerGate: ApprovalPolicy['dangerGate']
  readonly heartbeat: HeartbeatConfig
  readonly standingOrders: readonly string[]
  readonly channelRoles: Record<string, string>
  // 채널 용도 편집 대상으로 선택해 둔 채널(없으면 null).
  readonly selectedChannelId: string | null
  readonly activeSessions: number
  readonly pendingApprovals: number
  readonly onboardedAt: Date | null
}

export type AgentPanelMessage = {
  readonly components: readonly ContainerBuilder[]
  readonly flags: number
}

function cid(action: string): string {
  return `${AGENT_CFG_PREFIX}${action}`
}

function divider(): SeparatorBuilder {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Small)
}

function textChannelSelect(
  action: string,
  placeholder: string,
  currentId: string | null
): ActionRowBuilder<ChannelSelectMenuBuilder> {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(cid(action))
    .setPlaceholder(placeholder)
    .setMinValues(0)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
  if (currentId !== null) menu.setDefaultChannels(currentId)
  return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(menu)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export function buildAgentSettingsPanel(
  data: AgentPanelData
): AgentPanelMessage {
  const accent = data.dangerGate === 'none' ? ACCENT_WARN : ACCENT_NORMAL

  return {
    components: [
      buildHeaderContainer(accent, data),
      buildIdentityContainer(accent, data),
      buildPolicyContainer(accent, data),
      buildHeartbeatContainer(accent, data),
      buildChannelRolesContainer(accent, data),
      buildSessionContainer(accent),
    ],
    flags: MessageFlags.IsComponentsV2,
  }
}

function buildHeaderContainer(
  accent: number,
  data: AgentPanelData
): ContainerBuilder {
  const heartbeatText = data.heartbeat.enabled
    ? `켜짐${
        data.heartbeat.channelId !== null
          ? ` · <#${data.heartbeat.channelId}>`
          : ''
      }`
    : '꺼짐'
  const onboardingText =
    data.onboardedAt !== null
      ? `완료 (${data.onboardedAt.toLocaleDateString('ko-KR', {
          timeZone: 'Asia/Seoul',
        })})`
      : '미완료'

  return new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '# 🤖 AI 에이전트 셋업\n-# 에이전트에게 정체성(소울)과 이 서버에 대한 이해를 심어주고, 스스로 움직일 범위를 정해요. · 각 항목은 누르는 즉시 저장돼요.'
      )
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `- 위험 작업 승인: **${DANGER_GATE_LABELS[data.dangerGate]}**`,
          `- 자동 발화: **${heartbeatText}**`,
          `- 활성 세션: **${data.activeSessions}개** · 승인 대기: **${data.pendingApprovals}건**`,
          `- 온보딩: **${onboardingText}**`,
        ].join('\n')
      )
    )
}

function buildIdentityContainer(
  accent: number,
  data: AgentPanelData
): ContainerBuilder {
  const soulText =
    data.soul !== null && data.soul.trim().length > 0
      ? truncate(data.soul, 300)
      : '-# 아직 소울이 없어요. 에이전트가 누구인지 알려주세요.'
  const conceptText =
    data.concept !== null && data.concept.trim().length > 0
      ? truncate(data.concept, 200)
      : '미설정'
  const ordersText =
    data.standingOrders.length === 0
      ? '-# 등록된 상시 지침이 없어요.'
      : data.standingOrders.map((o, idx) => `${idx + 1}. ${o}`).join('\n')

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid(AGENT_CFG_ACTIONS.soulEdit))
      .setLabel('소울 편집')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid(AGENT_CFG_ACTIONS.conceptEdit))
      .setLabel('컨셉 편집')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid(AGENT_CFG_ACTIONS.orderAdd))
      .setLabel('지침 추가')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid(AGENT_CFG_ACTIONS.orderClear))
      .setLabel('지침 비우기')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(data.standingOrders.length === 0)
  )

  return new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          '### 🪞 정체성 · 서버 이해',
          '-# 소울(내가 누구인지)·서버 컨셉·상시 지침은 에이전트의 모든 대화에 주입돼요.',
          '',
          `**소울**\n${soulText}`,
          '',
          `**서버 컨셉**: ${conceptText}`,
          '',
          `**상시 지침**\n${ordersText}`,
        ].join('\n')
      )
    )
    .addActionRowComponents(buttons)
}

function buildPolicyContainer(
  accent: number,
  data: AgentPanelData
): ContainerBuilder {
  const gates: ApprovalPolicy['dangerGate'][] = [
    'admin_only',
    'requester',
    'none',
  ]
  const descriptions: Record<ApprovalPolicy['dangerGate'], string> = {
    admin_only: '위험 작업은 관리자·서버 주인만 승인 (기본값, 권장)',
    requester: '요청한 사람 본인이 승인',
    none: '승인 없이 즉시 실행 (주의)',
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid(AGENT_CFG_ACTIONS.policy))
    .setPlaceholder('위험 작업 승인 방식 선택')
    .addOptions(
      gates.map((gate) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(DANGER_GATE_LABELS[gate])
          .setDescription(descriptions[gate])
          .setValue(gate)
          .setDefault(gate === data.dangerGate)
      )
    )

  return new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '### 🛡️ 위험 작업 승인 정책\n-# 채널·역할 삭제, 추방/차단 같은 위험 도구를 실행하기 전 확인 방식이에요.'
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)
    )
}

function buildHeartbeatContainer(
  accent: number,
  data: AgentPanelData
): ContainerBuilder {
  const toggle = new ButtonBuilder()
    .setCustomId(cid(AGENT_CFG_ACTIONS.hbToggle))
    .setLabel(data.heartbeat.enabled ? '자동 발화 끄기' : '자동 발화 켜기')
    .setStyle(
      data.heartbeat.enabled ? ButtonStyle.Secondary : ButtonStyle.Success
    )

  return new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '### 🔔 자동 발화 (heartbeat)\n-# 에이전트가 먼저 말 거는 기능. 조용 시간(23~8시) 제외, 하루 최대 4회, 30분 간격 확인. 기본은 꺼짐이에요.'
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(toggle)
    )
    .addActionRowComponents(
      textChannelSelect(
        AGENT_CFG_ACTIONS.hbChannel,
        '자동 발화할 채널 선택',
        data.heartbeat.channelId
      )
    )
}

function buildChannelRolesContainer(
  accent: number,
  data: AgentPanelData
): ContainerBuilder {
  const entries = Object.entries(data.channelRoles)
  const rolesText =
    entries.length === 0
      ? '-# 지정된 채널 용도가 없어요.'
      : entries
          .slice(0, 8)
          .map(([id, purpose]) => `- <#${id}>: ${purpose}`)
          .join('\n') +
        (entries.length > 8 ? `\n-# …외 ${entries.length - 8}개` : '')

  const selectedText =
    data.selectedChannelId !== null
      ? `\n선택된 채널: <#${data.selectedChannelId}>`
      : '\n-# 채널을 먼저 선택한 뒤 **용도 입력**을 누르세요.'

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid(AGENT_CFG_ACTIONS.roleEdit))
      .setLabel('용도 입력')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(data.selectedChannelId === null),
    new ButtonBuilder()
      .setCustomId(cid(AGENT_CFG_ACTIONS.roleRemove))
      .setLabel('용도 제거')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(
        data.selectedChannelId === null ||
          data.channelRoles[data.selectedChannelId] === undefined
      )
  )

  return new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🗂️ 채널 용도\n-# 채널별 용도를 알려주면 에이전트가 그 채널에서 맥락에 맞게 행동해요.\n\n${rolesText}${selectedText}`
      )
    )
    .addActionRowComponents(
      textChannelSelect(
        AGENT_CFG_ACTIONS.roleChannel,
        '용도를 지정할 채널 선택',
        data.selectedChannelId
      )
    )
    .addActionRowComponents(buttons)
}

function buildSessionContainer(accent: number): ContainerBuilder {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid(AGENT_CFG_ACTIONS.sessionClear))
      .setLabel('이 채널 세션 초기화')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cid(AGENT_CFG_ACTIONS.refresh))
      .setLabel('새로고침')
      .setStyle(ButtonStyle.Secondary)
  )

  return new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '### 🧹 세션\n-# 이 명령을 실행한 채널의 AI 대화 세션을 초기화해요. 다음 멘션부터 새 대화로 시작해요.'
      )
    )
    .addActionRowComponents(buttons)
}

// ── 모달 (자유 텍스트 입력) ──

export function buildSoulModal(current: string | null): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${AGENT_CFG_MODAL_PREFIX}soul`)
    .setTitle('소울 — 에이전트 정체성')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('내가 누구인지 (비우면 삭제)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('value')
            .setPlaceholder(
              '예: 나는 풀문 서버의 도우미 코하루. 다정하지만 위험한 일은 신중하게.'
            )
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(1000)
            .setValue(current ?? '')
        )
    )
}

export function buildConceptModal(current: string | null): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${AGENT_CFG_MODAL_PREFIX}concept`)
    .setTitle('서버 컨셉 설정')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('서버 컨셉 (비우면 삭제)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('value')
            .setPlaceholder('예: 게임 커뮤니티, 스터디 서버')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(500)
            .setValue(current ?? '')
        )
    )
}

export function buildOrderAddModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${AGENT_CFG_MODAL_PREFIX}order`)
    .setTitle('상시 지침 추가')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('새 상시 지침')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('value')
            .setPlaceholder('예: 공지 채널에서는 잡담하지 말 것')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(300)
        )
    )
}

export function buildRoleModal(
  channelId: string,
  current: string | undefined
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${AGENT_CFG_MODAL_PREFIX}role:${channelId}`)
    .setTitle('채널 용도 설정')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('채널 용도 (비우면 삭제)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('value')
            .setPlaceholder('예: 공지 전용, 잡담, 봇 명령어')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(200)
            .setValue(current ?? '')
        )
    )
}
