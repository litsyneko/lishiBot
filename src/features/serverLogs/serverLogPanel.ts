import {
  SERVER_LOG_CATEGORY_DEFINITIONS,
  type ServerLogCategory,
  getVisibleServerLogCategories,
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
  RoleSelectMenuBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
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

// 컴포넌트 한도(40개 — ActionRow 안의 버튼/셀렉트도 각각 1개로 산정) 대비:
// 카테고리별 채널 셀렉트를 전부 펼치면 12개 × 3개로 초과하므로,
// 목록 뷰(카테고리 텍스트 + 카테고리 선택 드롭다운)와
// 카테고리 편집 뷰(해당 카테고리의 채널 셀렉트)를 같은 메시지 안에서 전환한다.
export function buildServerLogPanel(
  settings: ServerLogSettings,
  hasDraft: boolean,
  guildId: string,
  editingCategory: ServerLogCategory | null
): ServerLogPanelMessage {
  const container =
    editingCategory === null
      ? buildListContainer(settings, hasDraft, guildId)
      : buildCategoryEditContainer(settings, hasDraft, editingCategory)

  return { components: [container], flags: SERVER_LOG_PANEL_FLAGS }
}

export function buildExpiredServerLogPanel(
  settings: ServerLogSettings,
  guildId: string
): ServerLogPanelMessage {
  const activeCategoryCount = countActiveCategories(
    settings.categoryChannels,
    guildId
  )
  const summary = formatChannelSummary(settings, guildId)

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
  settings: ServerLogSettings,
  guildId: string
): ServerLogPanelMessage {
  const activeCategoryCount = countActiveCategories(
    settings.categoryChannels,
    guildId
  )
  const summary = formatChannelSummary(settings, guildId)

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

function buildListContainer(
  settings: ServerLogSettings,
  hasDraft: boolean,
  guildId: string
): ContainerBuilder {
  const accent = pickAccent(settings.enabled, hasDraft)
  const { channels, roles, users } = settings.exclusions

  const container = new ContainerBuilder().setAccentColor(accent)

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 서버 관리 로그 설정\n-# 감사 로그를 카테고리별로 지정한 채널에 기록합니다.${
        hasDraft ? ' · **저장되지 않은 변경 있음**' : ''
      }`
    )
  )
  container.addSeparatorComponents(buildDivider())
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### 현재 상태\n상태: **${
        settings.enabled ? '활성화' : '비활성화'
      }**\n연결: ${countActiveCategories(
        settings.categoryChannels,
        guildId
      )}개 카테고리`
    )
  )
  container.addActionRowComponents(buildControlRow(hasDraft))
  container.addSeparatorComponents(buildDivider())
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### 로그 채널\n${formatCategoryList(
        settings,
        guildId
      )}\n-# 아래 메뉴에서 카테고리를 선택해 채널을 지정하세요.`
    )
  )
  container.addActionRowComponents(buildCategoryPickRow(guildId))
  container.addSeparatorComponents(buildDivider())
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '### 로그 예외 설정\n-# 선택한 채널·유저·역할의 활동은 메시지/반응/음성/멤버 로그에서 제외돼요. 관리 감사 로그(채널·역할·설정 변경 등)는 항상 기록돼요.'
    )
  )
  appendExclusionRows(container, channels, users, roles)

  if (hasDraft) {
    container.addSeparatorComponents(buildDivider())
    container.addActionRowComponents(buildCommitRow())
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '-# 변경 사항은 **저장**을 누르거나 3분이 지나면 자동으로 적용돼요. 봇에게 감사 로그 보기, 채널 보기, 메시지 보내기 권한이 필요합니다.'
    )
  )

  return container
}

function buildCategoryEditContainer(
  settings: ServerLogSettings,
  hasDraft: boolean,
  category: ServerLogCategory
): ContainerBuilder {
  const accent = pickAccent(settings.enabled, hasDraft)
  const definition = categoryDefinition(category)
  const channelId = settings.categoryChannels[category]
  const channelLabel =
    channelId === null || channelId === undefined
      ? '채널 미지정'
      : `<#${channelId}>`

  const container = new ContainerBuilder().setAccentColor(accent)

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 로그 채널 지정 — ${
        definition.label
      }\n-# 채널을 선택하면 목록으로 돌아가요.${
        hasDraft ? ' · **저장되지 않은 변경 있음**' : ''
      }`
    )
  )
  container.addSeparatorComponents(buildDivider())
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${definition.label}\n${definition.description}\n현재: ${channelLabel}`
    )
  )

  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}cat:${category}`)
    .setPlaceholder(`${definition.label} 로그 채널 선택 (선택 해제 시 미지정)`)
    .setMinValues(0)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)

  if (channelId !== null && channelId !== undefined) {
    menu.setDefaultChannels(channelId)
  }

  container.addActionRowComponents(
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(menu)
  )
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}back`)
        .setLabel('목록으로')
        .setStyle(ButtonStyle.Secondary)
    )
  )

  if (hasDraft) {
    container.addSeparatorComponents(buildDivider())
    container.addActionRowComponents(buildCommitRow())
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '-# 변경 사항은 **저장**을 누르거나 3분이 지나면 자동으로 적용돼요.'
    )
  )

  return container
}

function formatCategoryList(
  settings: ServerLogSettings,
  guildId: string
): string {
  return getVisibleServerLogCategories(guildId)
    .map((category) => {
      const channelId = settings.categoryChannels[category]
      const channelLabel =
        channelId === null || channelId === undefined
          ? '미지정'
          : `<#${channelId}>`
      return `- ${categoryDefinition(category).label}: ${channelLabel}`
    })
    .join('\n')
}

function buildCategoryPickRow(
  guildId: string
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = getVisibleServerLogCategories(guildId).map((category) => {
    const definition = categoryDefinition(category)
    return new StringSelectMenuOptionBuilder()
      .setLabel(definition.label)
      .setValue(category)
      .setDescription(definition.description.slice(0, 100))
  })

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}pick`)
    .setPlaceholder('채널을 지정할 카테고리 선택')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options)

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)
}

function appendExclusionRows(
  container: ContainerBuilder,
  channels: readonly string[],
  users: readonly string[],
  roles: readonly string[]
): void {
  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}ignore:channels`)
    .setPlaceholder(
      channels.length > 0
        ? `제외 채널 ${channels.length}개 선택됨`
        : '로그에서 제외할 채널 선택'
    )
    .setMinValues(0)
    .setMaxValues(25)
  if (channels.length > 0) {
    channelMenu.setDefaultChannels(...channels)
  }

  const userMenu = new UserSelectMenuBuilder()
    .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}ignore:users`)
    .setPlaceholder(
      users.length > 0
        ? `제외 유저 ${users.length}명 선택됨`
        : '로그에서 제외할 유저 선택'
    )
    .setMinValues(0)
    .setMaxValues(25)
  if (users.length > 0) {
    userMenu.setDefaultUsers(...users)
  }

  const roleMenu = new RoleSelectMenuBuilder()
    .setCustomId(`${SERVER_LOG_COMPONENT_PREFIX}ignore:roles`)
    .setPlaceholder(
      roles.length > 0
        ? `제외 역할 ${roles.length}개 선택됨`
        : '로그에서 제외할 역할 선택'
    )
    .setMinValues(0)
    .setMaxValues(25)
  if (roles.length > 0) {
    roleMenu.setDefaultRoles(...roles)
  }

  container.addActionRowComponents(
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelMenu)
  )
  container.addActionRowComponents(
    new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userMenu)
  )
  container.addActionRowComponents(
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleMenu)
  )
}

function buildControlRow(hasDraft: boolean): ActionRowBuilder<ButtonBuilder> {
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

function pickAccent(enabled: boolean, hasDraft: boolean): number {
  if (hasDraft) return ACCENT_DRAFT
  return enabled ? ACCENT_ON : ACCENT_OFF
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

function countActiveCategories(
  map: {
    readonly [key: string]: string | null | undefined
  },
  guildId: string
): number {
  let count = 0
  for (const category of getVisibleServerLogCategories(guildId)) {
    const value = map[category]
    if (value !== null && value !== undefined) {
      count += 1
    }
  }
  return count
}

function formatChannelSummary(
  settings: ServerLogSettings,
  guildId: string
): string {
  const lines: string[] = []
  for (const category of getVisibleServerLogCategories(guildId)) {
    const channelId = settings.categoryChannels[category]
    if (channelId === null || channelId === undefined) continue
    const label = categoryDefinition(category).label
    lines.push(`- ${label}: <#${channelId}>`)
  }

  const { channels, roles, users } = settings.exclusions
  if (channels.length + roles.length + users.length > 0) {
    lines.push(
      `- 예외: 채널 ${channels.length}개 · 유저 ${users.length}명 · 역할 ${roles.length}개`
    )
  }

  return lines.length === 0 ? '- 지정된 채널이 없어요.' : lines.join('\n')
}

function buildDivider(): SeparatorBuilder {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Small)
}
