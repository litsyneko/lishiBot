import {
  DEFAULT_NAME_TEMPLATE,
  OWNER_GRACE_CHOICES,
  type TempVoiceSettings,
} from './tempVoiceSettings'
import {
  ContainerBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from '@discordjs/builders'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'

export const TVSET_PREFIX = 'tvset:'
export const TVSET_MODAL_PREFIX = 'tvsetModal:'

export const TVSET_ACTIONS = {
  generator: 'generator',
  createGenerator: 'createGenerator',
  category: 'category',
  logChannel: 'logChannel',
  toggle: 'toggle',
  editTemplate: 'template',
  grace: 'grace',
  save: 'save',
  cancel: 'cancel',
} as const

export const TVSET_MODALS = {
  template: 'template',
} as const

export const TVSET_PANEL_FLAGS = MessageFlags.IsComponentsV2

export type TempVoicePanelMessage = {
  readonly components: readonly ContainerBuilder[]
  readonly flags: number
}

const ACCENT_DRAFT = 0xf39c12
const ACCENT_ON = 0x2ecc71
const ACCENT_OFF = 0x95a5a6
const ACCENT_SAVED = 0x2ecc71
const ACCENT_CANCELLED = 0xe74c3c

function cid(action: string): string {
  return `${TVSET_PREFIX}${action}`
}

function pickAccent(enabled: boolean, hasDraft: boolean): number {
  if (hasDraft) return ACCENT_DRAFT
  return enabled ? ACCENT_ON : ACCENT_OFF
}

function divider(): SeparatorBuilder {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Small)
}

function graceLabel(minutes: number): string {
  return minutes <= 0 ? '즉시 위임' : `${minutes}분 후 위임`
}

function limitLabel(limit: number): string {
  return limit <= 0 ? '무제한' : `${limit}명`
}

export function buildTempVoicePanel(
  settings: TempVoiceSettings,
  hasDraft: boolean
): TempVoicePanelMessage {
  const accent = pickAccent(settings.enabled, hasDraft)
  const draftBadge = hasDraft ? ' · **저장되지 않은 변경 있음**' : ''

  // 하나의 컨테이너에 모든 섹션을 담는다(임베드 여러 개로 쪼개지 않음).
  const panel = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 임시 통화방 설정\n-# 생성 채널에 입장하면 개인 통화방을 자동으로 만들어줘요.${draftBadge}`
      )
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `### 현재 상태`,
          `상태: **${settings.enabled ? '🟢 활성화' : '⚪ 비활성화'}**`,
          `생성 채널: ${
            settings.generatorChannelId !== null
              ? `<#${settings.generatorChannelId}>`
              : '**미지정** — 지정해야 통화방이 만들어져요'
          }`,
          `카테고리: ${
            settings.categoryId !== null
              ? `<#${settings.categoryId}>`
              : '생성 채널과 동일'
          }`,
          `로그 채널: ${
            settings.logChannelId !== null
              ? `<#${settings.logChannelId}>`
              : '미설정'
          }`,
          `이름 템플릿: \`${settings.nameTemplate}\``,
          `기본 인원: **${limitLabel(
            settings.defaultUserLimit
          )}** · 자동 위임 **${graceLabel(
            settings.ownerGraceMinutes
          )}** · 쿨다운 **${settings.cooldownSeconds}초**`,
        ].join('\n')
      )
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '### 생성 채널\n-# 이 음성 채널에 들어오면 통화방이 만들어져요. 기존 채널을 고르거나 새로 만드세요.'
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        buildChannelSelect(
          TVSET_ACTIONS.generator,
          '기존 음성 채널에서 선택',
          [ChannelType.GuildVoice],
          settings.generatorChannelId
        )
      )
    )

  if (settings.generatorChannelId === null) {
    panel.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(cid(TVSET_ACTIONS.createGenerator))
          .setLabel('➕ 생성 채널 새로 만들기')
          .setStyle(ButtonStyle.Success)
      )
    )
  }

  panel
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '### 통화방 카테고리\n-# 통화방이 만들어질 카테고리. 비우면 생성 채널과 같은 위치.'
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        buildChannelSelect(
          TVSET_ACTIONS.category,
          '카테고리 선택 (선택)',
          [ChannelType.GuildCategory],
          settings.categoryId
        )
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '### 로그 채널\n-# 통화방 생성·삭제·방장 이전·내보내기 기록을 남길 채널 (선택).'
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        buildChannelSelect(
          TVSET_ACTIONS.logChannel,
          '로그 채널 선택 (선택)',
          [ChannelType.GuildText, ChannelType.GuildAnnouncement],
          settings.logChannelId
        )
      )
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '### 방장 자동 위임 유예\n-# 방장이 나간 뒤 이 시간 안에 돌아오지 않으면 남은 인원 중 최고참에게 방장이 넘어가요.'
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        buildGraceSelect(settings.ownerGraceMinutes)
      )
    )
    .addSeparatorComponents(divider())
    .addActionRowComponents(buildControlRow(settings))

  if (hasDraft) {
    panel.addActionRowComponents(buildCommitRow())
  }

  panel.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '-# 봇에게 채널 관리·멤버 이동 권한이 필요해요. **저장**을 누르거나 3분간 조작이 없으면 저장돼요.'
    )
  )

  return {
    components: [panel],
    flags: TVSET_PANEL_FLAGS,
  }
}

function buildChannelSelect(
  action: string,
  placeholder: string,
  types: ChannelType[],
  current: string | null
): ChannelSelectMenuBuilder {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(cid(action))
    .setPlaceholder(placeholder)
    .setMinValues(0)
    .setMaxValues(1)
    .addChannelTypes(...types)
  if (current !== null) menu.setDefaultChannels(current)
  return menu
}

function buildGraceSelect(current: number): StringSelectMenuBuilder {
  return new StringSelectMenuBuilder()
    .setCustomId(cid(TVSET_ACTIONS.grace))
    .setPlaceholder('방장 자동 위임 시간 선택')
    .addOptions(
      OWNER_GRACE_CHOICES.map((minutes) => ({
        label: graceLabel(minutes),
        value: String(minutes),
        default: minutes === current,
      }))
    )
}

function buildControlRow(
  settings: TempVoiceSettings
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid(TVSET_ACTIONS.toggle))
      .setLabel(settings.enabled ? '비활성화' : '활성화')
      .setStyle(settings.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cid(TVSET_ACTIONS.editTemplate))
      .setLabel('이름 템플릿·인원·쿨다운')
      .setStyle(ButtonStyle.Secondary)
  )
}

function buildCommitRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid(TVSET_ACTIONS.save))
      .setLabel('저장')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cid(TVSET_ACTIONS.cancel))
      .setLabel('취소')
      .setStyle(ButtonStyle.Danger)
  )
}

export function buildTemplateModal(settings: TempVoiceSettings): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${TVSET_MODAL_PREFIX}${TVSET_MODALS.template}`)
    .setTitle('통화방 기본값 설정')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('이름 템플릿 ({user}=닉네임, {count}=순번)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('template')
            .setPlaceholder(DEFAULT_NAME_TEMPLATE)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(80)
            .setValue(settings.nameTemplate)
        ),
      new LabelBuilder()
        .setLabel('기본 인원 제한 (0=무제한, 최대 99)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('limit')
            .setPlaceholder('0')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(2)
            .setValue(String(settings.defaultUserLimit))
        ),
      new LabelBuilder()
        .setLabel('연속 생성 쿨다운 (초, 0~600)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('cooldown')
            .setPlaceholder('30')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(3)
            .setValue(String(settings.cooldownSeconds))
        )
    )
}

export function buildSavedPanel(
  settings: TempVoiceSettings
): TempVoicePanelMessage {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT_SAVED)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '# 통화방 설정 저장 완료\n-# 설정한 값으로 임시 통화방이 동작해요.'
      )
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          `상태: **${settings.enabled ? '활성화' : '비활성화'}**`,
          `생성 채널: ${
            settings.generatorChannelId !== null
              ? `<#${settings.generatorChannelId}>`
              : '미지정'
          }`,
          `방장 자동 위임: **${graceLabel(settings.ownerGraceMinutes)}**`,
        ].join('\n')
      )
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '-# 다시 설정하려면 `/통화방설정`을 입력해 주세요.'
      )
    )
  return { components: [container], flags: TVSET_PANEL_FLAGS }
}

export function buildCancelledPanel(): TempVoicePanelMessage {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT_CANCELLED)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '# 통화방 설정 (취소됨)\n-# 변경 사항을 저장하지 않고 닫았어요.'
      )
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '-# 다시 설정하려면 `/통화방설정`을 입력해 주세요.'
      )
    )
  return { components: [container], flags: TVSET_PANEL_FLAGS }
}

export function buildExpiredPanel(
  settings: TempVoiceSettings
): TempVoicePanelMessage {
  const container = new ContainerBuilder()
    .setAccentColor(0x7289da)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '# 통화방 설정 (만료됨)\n-# 3분간 조작이 없어 자동으로 저장했어요.'
      )
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `상태: **${settings.enabled ? '활성화' : '비활성화'}**`
      )
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '-# 다시 설정하려면 `/통화방설정`을 입력해 주세요.'
      )
    )
  return { components: [container], flags: TVSET_PANEL_FLAGS }
}
