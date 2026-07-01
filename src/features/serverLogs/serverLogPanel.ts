import {
  SERVER_LOG_CATEGORIES,
  SERVER_LOG_CATEGORY_DEFINITIONS,
  type ServerLogCategory,
} from './serverLogCategories'
import type { ServerLogSettings } from './serverLogSettings'
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
  MessageFlags,
  SeparatorSpacingSize,
} from 'discord.js'

export const SERVER_LOG_COMPONENT_PREFIX = 'serverlog:'
export const SERVER_LOG_PANEL_FLAGS = MessageFlags.IsComponentsV2

export type ServerLogPanelMessage = {
  readonly components: readonly ContainerBuilder[]
  readonly flags: number
}

const ACCENT_DRAFT = 0xf39c12
const ACCENT_ON = 0x2ecc71
const ACCENT_OFF = 0x95a5a6
const ACCENT_EXPIRED = 0x7289da
const ACCENT_CANCELLED = 0xe74c3c
const CATEGORIES_PER_PAGE = 5
export const SERVER_LOG_PAGE_COUNT = Math.ceil(
  SERVER_LOG_CATEGORIES.length / CATEGORIES_PER_PAGE
)

export function buildServerLogPanel(
  settings: ServerLogSettings,
  page: number,
  hasDraft: boolean
): ServerLogPanelMessage {
  const activeCategoryCount = countActiveCategories(settings.categoryChannels)
  const accent = pickAccent(settings.enabled, hasDraft)

  const containers: ContainerBuilder[] = [
    buildHeaderContainer(accent, settings, activeCategoryCount, page, hasDraft),
    buildCategoryContainer(accent, settings, page),
    buildNavigationContainer(accent, page, hasDraft),
  ]

  return {
    components: containers,
    flags: SERVER_LOG_PANEL_FLAGS,
  }
}

export function buildExpiredServerLogPanel(
  settings: ServerLogSettings
): ServerLogPanelMessage {
  const activeCategoryCount = countActiveCategories(settings.categoryChannels)
  const summary = formatChannelSummary(settings)

  const container = new ContainerBuilder()
    .setAccentColor(ACCENT_EXPIRED)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '# 서버 관리 로그 설정 (만료됨)\n-# 3분 내 상호작용이 없어 자동으로 저장됐어요.'
      )
    )
    .addSeparatorComponents(buildDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 저장된 상태\n상태: **${
          settings.enabled ? '활성화' : '비활성화'
        }**\n연결: ${activeCategoryCount}개 카테고리\n${summary}`
      )
    )
    .addSeparatorComponents(buildDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '-# 다시 설정하려면 `/관리로그`를 입력해 주세요.'
      )
    )

  return {
    components: [container],
    flags: SERVER_LOG_PANEL_FLAGS,
  }
}

export function buildCancelledServerLogPanel(): ServerLogPanelMessage {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT_CANCELLED)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '# 서버 관리 로그 설정 (취소됨)\n-# 변경 사항을 저장하지 않고 닫았어요.'
      )
    )
    .addSeparatorComponents(buildDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '-# 다시 설정하려면 `/관리로그`를 입력해 주세요.'
      )
    )

  return {
    components: [container],
    flags: SERVER_LOG_PANEL_FLAGS,
  }
}

export function buildSavedServerLogPanel(
  settings: ServerLogSettings
): ServerLogPanelMessage {
  const activeCategoryCount = countActiveCategories(settings.categoryChannels)
  const summary = formatChannelSummary(settings)

  const container = new ContainerBuilder()
    .setAccentColor(ACCENT_ON)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '# 로그 설정 저장 완료\n-# <a:Lishi_07:1521143128025731263> 로그 설정이 정상적으로 저장을 완료했어요. 이제부터 설정한 설정 값으로 지정채널에 로그를 기록해요.'
      )
    )
    .addSeparatorComponents(buildDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 저장된 상태\n상태: **${
          settings.enabled ? '활성화' : '비활성화'
        }**\n연결: ${activeCategoryCount}개 카테고리\n${summary}`
      )
    )
    .addSeparatorComponents(buildDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '-# 다시 설정하려면 `/관리로그`를 입력해 주세요.'
      )
    )

  return {
    components: [container],
    flags: SERVER_LOG_PANEL_FLAGS,
  }
}

function pickAccent(enabled: boolean, hasDraft: boolean): number {
  if (hasDraft) return ACCENT_DRAFT
  return enabled ? ACCENT_ON : ACCENT_OFF
}

function buildHeaderContainer(
  accent: number,
  settings: ServerLogSettings,
  activeCategoryCount: number,
  page: number,
  hasDraft: boolean
): ContainerBuilder {
  const enabledText = settings.enabled ? '활성화' : '비활성화'
  const channelText =
    activeCategoryCount === 0
      ? '아직 채널이 지정되지 않음'
      : `${activeCategoryCount}개 카테고리에 채널 지정됨`
  const draftBadge = hasDraft ? ' · **저장되지 않은 변경 있음**' : ''

  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 서버 관리 로그 설정\n-# 감사 로그를 카테고리별로 지정한 채널에 기록합니다. · 페이지 ${
          page + 1
        }/${SERVER_LOG_PAGE_COUNT}${draftBadge}`
      )
    )
    .addSeparatorComponents(buildDivider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 현재 상태\n상태: **${enabledText}**\n연결: ${channelText}`
      )
    )
    .addSeparatorComponents(buildDivider())
    .addActionRowComponents(buildActionRow(hasDraft))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '-# 각 카테고리의 로그를 받을 채널을 선택하세요. **저장** 버튼을 눌러야 변경 사항이 확정돼요.'
      )
    )

  return container
}

function buildCategoryContainer(
  accent: number,
  settings: ServerLogSettings,
  page: number
): ContainerBuilder {
  const start = page * CATEGORIES_PER_PAGE
  const categories = SERVER_LOG_CATEGORIES.slice(
    start,
    start + CATEGORIES_PER_PAGE
  )

  const container = new ContainerBuilder().setAccentColor(accent)

  for (const category of categories) {
    const definition = categoryDefinition(category)
    const channelId = settings.categoryChannels[category]
    const channelLabel =
      channelId === null || channelId === undefined
        ? '채널 미지정'
        : `<#${channelId}>`

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### ${definition.label}\n-# ${definition.description} · 현재: ${channelLabel}`
      )
    )

    const menu = new ChannelSelectMenuBuilder()
      .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}cat:${category}`)
      .setPlaceholder(`${definition.label} 로그 채널 선택`)
      .setMinValues(0)
      .setMaxValues(1)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)

    if (channelId !== null && channelId !== undefined) {
      menu.setDefaultChannels(channelId)
    }

    container.addActionRowComponents(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(menu)
    )
  }

  return container
}

function buildNavigationContainer(
  accent: number,
  page: number,
  hasDraft: boolean
): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(accent)
  container.addActionRowComponents(buildNavigationRow(page))

  if (hasDraft) {
    container.addActionRowComponents(buildCommitRow())
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '-# 봇에게 감사 로그 보기, 채널 보기, 메시지 보내기 권한이 필요합니다.'
    )
  )

  return container
}

function buildActionRow(hasDraft: boolean): ActionRowBuilder<ButtonBuilder> {
  const toggle = new ButtonBuilder()
    .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}toggle`)
    .setLabel(hasDraft ? '켜기/끄기' : '일시 정지')
    .setStyle(ButtonStyle.Secondary)

  const clear = new ButtonBuilder()
    .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}clear`)
    .setLabel('채널 전체 해제')
    .setStyle(ButtonStyle.Danger)

  const refresh = new ButtonBuilder()
    .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}refresh`)
    .setLabel('현재 새로고침')
    .setStyle(ButtonStyle.Secondary)

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    toggle,
    clear,
    refresh
  )
}

function buildCommitRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}save`)
      .setLabel('저장')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}cancel`)
      .setLabel('취소')
      .setStyle(ButtonStyle.Danger)
  )
}

function buildNavigationRow(page: number): ActionRowBuilder<ButtonBuilder> {
  const buttons: ButtonBuilder[] = []

  if (page > 0) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}page:${page - 1}`)
        .setLabel('이전 페이지')
        .setStyle(ButtonStyle.Primary)
    )
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}page:${page}`)
      .setLabel(`페이지 ${page + 1}/${SERVER_LOG_PAGE_COUNT}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  )

  if (page < SERVER_LOG_PAGE_COUNT - 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}page:${page + 1}`)
        .setLabel('다음 페이지')
        .setStyle(ButtonStyle.Primary)
    )
  }

  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)
}

function categoryDefinition(category: ServerLogCategory) {
  return (
    SERVER_LOG_CATEGORY_DEFINITIONS.find((item) => item.id === category) ?? {
      description: category,
      id: category,
      label: category,
    }
  )
}

function countActiveCategories(map: {
  readonly [key: string]: string | null | undefined
}): number {
  let count = 0
  for (const category of SERVER_LOG_CATEGORIES) {
    const value = map[category]
    if (value !== null && value !== undefined) {
      count += 1
    }
  }
  return count
}

function formatChannelSummary(settings: ServerLogSettings): string {
  const lines: string[] = []
  for (const category of SERVER_LOG_CATEGORIES) {
    const channelId = settings.categoryChannels[category]
    if (channelId === null || channelId === undefined) continue
    const label = categoryDefinition(category).label
    lines.push(`- ${label}: <#${channelId}>`)
  }
  return lines.length === 0 ? '- 지정된 채널이 없어요.' : lines.join('\n')
}

function buildDivider(): SeparatorBuilder {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Small)
}
