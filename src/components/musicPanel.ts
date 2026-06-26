import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SectionBuilder,
  ThumbnailBuilder,
} from '@discordjs/builders'
import {
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} from 'discord.js'
import type { Track } from 'lavalink-client'
import type { CustomPlayer } from '../music/customPlayer'
import { formatDuration } from '../music/musicService'

export type PanelTrackInfo = {
  readonly author: string
  readonly durationMs: number
  readonly title: string
  readonly artworkUrl?: string
  readonly identifier?: string
  readonly sourceName?: string
  readonly uri?: string
}

export type PanelQueueInfo = {
  readonly remaining: number
  readonly total: number
}

export type MusicPanelMessage = {
  readonly components: unknown[]
  readonly flags: number
}

const SPOTIFY_GREEN = 0x1db954

function escapeMarkdown(text: string): string {
  return text.replace(/([\\\[\]*_~`>|])/gu, '\\$1')
}

function resolveThumbnail(track: PanelTrackInfo): string | undefined {
  if (track.artworkUrl !== undefined && track.artworkUrl.length > 0) {
    return track.artworkUrl
  }
  if (track.sourceName === 'youtube' && track.identifier !== undefined) {
    return `https://i.ytimg.com/vi/${track.identifier}/mqdefault.jpg`
  }
  return undefined
}

function buildProgressBar(positionMs: number, durationMs: number): string {
  if (durationMs <= 0 || Number.isNaN(durationMs)) {
    return ''
  }

  const ratio = positionMs / durationMs
  const elapsed = formatDuration(positionMs)
  const total = formatDuration(durationMs)

  return `${elapsed}  ${emojiProgressBar(ratio)}  ${total}`
}

const EMOJI_PROGRESS_START_SINGLE_WHITE = '<:progress_start_single:1519800527309897808>'
const EMOJI_PROGRESS_START_WHITE = '<:progress_start_white:1519800529419632680>'
const EMOJI_PROGRESS_WHITE = '<:progress_bar_white:1519800538621808723>'
const EMOJI_PROGRESS_END_WHITE = '<:progress_end_white:1519800530749362206>'
const EMOJI_PROGRESS_END_MIDDLE_WHITE = '<:progress_end_middle_white:1519800535069495306>'
const EMOJI_PROGRESS_START_BLACK = '<:progress_start_black:1519800532271628520>'
const EMOJI_PROGRESS_BLACK = '<:progress_bar_black:1519800536894017536>'
const EMOJI_PROGRESS_END_BLACK = '<:progress_end_black:1519800533626523870>'
const PROGRESS_BAR_EMOJI_COUNT = 9

const EMOJI_BTN_LEFT = '<:btn_left:955803837095088128>'
const EMOJI_BTN_RIGHT = '<:btn_right:955803837254488074>'
const EMOJI_BTN_STOP = '<:btn_stop:955804418815721472>'
const EMOJI_REFRESH = '<:refresh_btn:972106966346399804>'

const VOLUME_EMOJI_MUTE = '🔇'
const VOLUME_EMOJI_LOW = '🔉'
const VOLUME_EMOJI_HIGH = '🔊'

export function volumeToEmoji(volume: number): string {
  if (volume < 1) return VOLUME_EMOJI_MUTE
  if (volume < 50) return VOLUME_EMOJI_LOW
  return VOLUME_EMOJI_HIGH
}

export function emojiProgressBar(percent: number): string {
  const clamped = Math.min(1, Math.max(0, percent))
  const p = Math.floor(clamped * PROGRESS_BAR_EMOJI_COUNT)
  const parts: string[] = []

  if (p === 0) {
    parts.push(EMOJI_PROGRESS_START_BLACK)
  } else if (p === 1) {
    parts.push(EMOJI_PROGRESS_START_SINGLE_WHITE)
  } else {
    parts.push(EMOJI_PROGRESS_START_WHITE)
  }

  for (let i = 1; i < PROGRESS_BAR_EMOJI_COUNT - 1; i++) {
    if (p > i) {
      parts.push(
        p - 1 === i
          ? p === PROGRESS_BAR_EMOJI_COUNT - 1
            ? EMOJI_PROGRESS_WHITE
            : EMOJI_PROGRESS_END_MIDDLE_WHITE
          : EMOJI_PROGRESS_WHITE,
      )
    } else {
      parts.push(EMOJI_PROGRESS_BLACK)
    }
  }

  if (p >= PROGRESS_BAR_EMOJI_COUNT) {
    parts.push(EMOJI_PROGRESS_END_WHITE)
  } else {
    parts.push(EMOJI_PROGRESS_END_BLACK)
  }

  return parts.join('')
}

// ── Queue page constants ──────────────────────────────

const QUEUE_PAGE_SIZE = 5
const PREFIX = 'ctrl:'

function buildNowplayingSection(container: ContainerBuilder, player: CustomPlayer, trackInfo: Track['info']): void {
  const headerText = `-# 🎵 <#${player.voiceChannelId}> 에서 ${player.paused ? '일시 정지' : '재생'} 중`
  const titleLine = trackInfo.uri !== undefined && trackInfo.uri.length > 0
    ? `### [${escapeMarkdown(trackInfo.title)}](${trackInfo.uri})`
    : `### ${escapeMarkdown(trackInfo.title)}`
  const artistLine = `**${trackInfo.author ?? '알 수 없음'}**`
  const progressLine = buildProgressBar(player.position, trackInfo.duration ?? 0)

  const current = player.queue.current
  const requesterId = (current?.requester as { id?: string } | undefined)?.id
  const requesterLine = requesterId !== undefined
    ? `-# 신청자: <@${requesterId}>`
    : undefined

  const nowplayingText = [
    headerText,
    titleLine,
    artistLine,
    progressLine,
    requesterLine,
  ]
    .filter((line): line is string => line !== undefined && line.length > 0)
    .join('\n')

  const textDisplay = new TextDisplayBuilder().setContent(nowplayingText)

  const thumbnailUrl = resolveThumbnail({
    author: trackInfo.author ?? '알 수 없음',
    durationMs: trackInfo.duration ?? 0,
    title: trackInfo.title,
    artworkUrl: trackInfo.artworkUrl ?? undefined,
    identifier: trackInfo.identifier,
    sourceName: trackInfo.sourceName,
    uri: trackInfo.uri,
  })

  if (thumbnailUrl !== undefined) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(textDisplay)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl).setDescription(trackInfo.title))
    container.addSectionComponents(section)
  } else {
    container.addTextDisplayComponents(textDisplay)
  }
}

function buildQueueSection(container: ContainerBuilder, player: CustomPlayer): void {
  const tracks = player.queue.tracks

  container
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )

  if (tracks.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('### 📄 대기열\n-# 대기열이 비어 있어요.'),
    )
    return
  }

  const totalDuration = tracks.reduce((acc, t) => acc + (t.info.duration ?? 0), 0)
  const totalPages = Math.max(1, Math.ceil(tracks.length / QUEUE_PAGE_SIZE))
  const page = Math.min(player.controllerPage, totalPages)

  const pageStart = (page - 1) * QUEUE_PAGE_SIZE
  const pageTracks = tracks.slice(pageStart, pageStart + QUEUE_PAGE_SIZE)

  const queueText = pageTracks
    .map((track, idx) => {
      const t = track as Track
      const displayIdx = pageStart + idx + 1
      const dur = formatDuration(t.info.duration ?? 0)
      const title = t.info.uri !== undefined && t.info.uri.length > 0
        ? `[${escapeMarkdown(t.info.title)}](${t.info.uri})`
        : escapeMarkdown(t.info.title)
      return `\`\`#${displayIdx}\`\` ${title} \`${dur}\``
    })
    .join('\n')

  const totalText = formatDuration(totalDuration)
  const queueHeader = `### 📄 대기열 (${page}/${totalPages})\n${queueText}\n-# 총 ${tracks.length}곡 (${totalText})`

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(queueHeader))

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}qsel`)
    .setPlaceholder('곡을 선택하세요')
    .addOptions(
      pageTracks.map((track, idx) => {
        const t = track as Track
        const displayIdx = pageStart + idx + 1
        const label = t.info.title.length > 80
          ? `#${displayIdx} ${t.info.title.slice(0, 77)}...`
          : `#${displayIdx} ${t.info.title}`
        return {
          label,
          value: String(displayIdx),
          description: t.info.author ?? '알 수 없음',
        }
      }),
    )

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)
  container.addActionRowComponents(selectRow)

  const queueActionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}qprev`)
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}qnext`)
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}qjump`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('↪️'),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}qrm`)
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️'),
  )
  container.addActionRowComponents(queueActionRow)
}

function buildPlaybackTab(container: ContainerBuilder, player: CustomPlayer, trackInfo: Track['info']): void {
  buildNowplayingSection(container, player, trackInfo)

  const queueOpen = player.queueVisible
  const repeatMode = (player.repeatMode ?? 'off') as 'off' | 'track' | 'queue'

  const repeatEmoji = repeatMode === 'track' ? '🔂' : repeatMode === 'queue' ? '🔁' : '🔁'

  const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}prev`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(EMOJI_BTN_LEFT),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}pause`)
      .setStyle(player.paused ? ButtonStyle.Success : ButtonStyle.Primary)
      .setEmoji(player.paused ? '▶️' : '⏸️'),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}skip`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(EMOJI_BTN_RIGHT),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}repeat`)
      .setStyle(repeatMode !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setEmoji(repeatEmoji),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}shuffle`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔀'),
  )

  const utilRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}stop`)
      .setStyle(ButtonStyle.Danger)
      .setEmoji(EMOJI_BTN_STOP),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}queueToggle`)
      .setStyle(queueOpen ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setEmoji('📜'),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}tabSettings`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⚙️'),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}refresh`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(EMOJI_REFRESH),
  )

  container
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addActionRowComponents(controlRow)
    .addActionRowComponents(utilRow)

  if (queueOpen) {
    buildQueueSection(container, player)
  }
}

function buildSettingsTab(container: ContainerBuilder, player: CustomPlayer, trackInfo: Track['info']): void {
  buildNowplayingSection(container, player, trackInfo)

  const volume = player.volume

  const volumeText = new TextDisplayBuilder().setContent(
    `### ⚙️ 설정\n${volumeToEmoji(volume)} 볼륨: **${volume}%**`,
  )

  container
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(volumeText)

  const volRow1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}volDown10`)
      .setLabel('-10')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}volDown5`)
      .setLabel('-5')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}volMute`)
      .setStyle(volume === 0 ? ButtonStyle.Danger : ButtonStyle.Secondary)
      .setEmoji('🔇'),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}volUp5`)
      .setLabel('+5')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}volUp10`)
      .setLabel('+10')
      .setStyle(ButtonStyle.Secondary),
  )

  const volRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}tabPlayback`)
      .setStyle(ButtonStyle.Primary)
      .setEmoji(EMOJI_BTN_LEFT),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}refresh`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(EMOJI_REFRESH),
  )

  container.addActionRowComponents(volRow1).addActionRowComponents(volRow2)
}

export function buildControllerPanel(player: CustomPlayer): MusicPanelMessage {
  const current = player.queue.current
  if (current === undefined || current === null) {
    return {
      components: [],
      flags: MessageFlags.IsComponentsV2,
    }
  }

  const container = new ContainerBuilder().setAccentColor(SPOTIFY_GREEN)
  const trackInfo = current.info
  const tab = player.controllerTab

  if (tab === 'settings') {
    buildSettingsTab(container, player, trackInfo)
  } else {
    buildPlaybackTab(container, player, trackInfo)
  }

  const footerParts: string[] = []
  footerParts.push(`📡 ${player.node.id}`)
  footerParts.push(`${volumeToEmoji(player.volume)} ${player.volume}%`)
  container
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${footerParts.join(' | ')}`),
    )

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  }
}

export type AddedToQueueInput = {
  readonly track: PanelTrackInfo
  readonly queuePosition?: number
  readonly isPlaying: boolean
}

export function buildTrackAdded(input: AddedToQueueInput): MusicPanelMessage {
  const { track, queuePosition, isPlaying } = input

  const firstLine = isPlaying ? '🎶 노래를 곧 재생할게요!' : `🎵 대기열에 추가했어요.`
  const titleLine = track.uri !== undefined && track.uri.length > 0
    ? `### [${escapeMarkdown(track.title)}](${track.uri})`
    : `### ${escapeMarkdown(track.title)}`
  const artistLine = `**${track.author}**`
  const positionLine = !isPlaying && queuePosition !== undefined
    ? `-# 대기열 ${queuePosition}번째`
    : undefined

  const content = [firstLine, titleLine, artistLine, positionLine]
    .filter((line): line is string => line !== undefined)
    .join('\n')

  const textDisplay = new TextDisplayBuilder().setContent(content)
  const container = new ContainerBuilder().setAccentColor(SPOTIFY_GREEN)

  const thumbnailUrl = resolveThumbnail(track)
  if (thumbnailUrl !== undefined) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(textDisplay)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl).setDescription(track.title))
    container.addSectionComponents(section)
  } else {
    container.addTextDisplayComponents(textDisplay)
  }

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  }
}

export type PlaylistQueuedInput = {
  readonly playlistName: string
  readonly trackCount: number
  readonly firstTrack: PanelTrackInfo
}

export function buildPlaylistQueued(input: PlaylistQueuedInput): MusicPanelMessage {
  const { playlistName, trackCount, firstTrack } = input

  const header = `### 📝 플레이리스트를 추가했어요`
  const body = `**${playlistName}**\n${trackCount}곡을 대기열에 추가했어요.`
  const firstLine = firstTrack.uri !== undefined && firstTrack.uri.length > 0
    ? `-# 첫 곡: [${escapeMarkdown(firstTrack.title)}](${firstTrack.uri}) — ${firstTrack.author}`
    : `-# 첫 곡: ${escapeMarkdown(firstTrack.title)} — ${firstTrack.author}`

  const content = [header, body, firstLine].join('\n')

  const textDisplay = new TextDisplayBuilder().setContent(content)
  const container = new ContainerBuilder().setAccentColor(SPOTIFY_GREEN)

  const thumbnailUrl = resolveThumbnail(firstTrack)
  if (thumbnailUrl !== undefined) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(textDisplay)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl).setDescription(firstTrack.title))
    container.addSectionComponents(section)
  } else {
    container.addTextDisplayComponents(textDisplay)
  }

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  }
}

export type StoppedPanelInput = {
  readonly track?: PanelTrackInfo
}

export function buildStoppedPanel(input: StoppedPanelInput): MusicPanelMessage {
  const header = '⏹ 재생을 종료했어요.'

  const textParts: string[] = [header]

  if (input.track !== undefined) {
    const titleLine = input.track.uri !== undefined && input.track.uri.length > 0
      ? `### [${escapeMarkdown(input.track.title)}](${input.track.uri})`
      : `### ${escapeMarkdown(input.track.title)}`
    const artistLine = `**${input.track.author}**`
    textParts.push(titleLine, artistLine)
  }

  const content = textParts.join('\n')

  const textDisplay = new TextDisplayBuilder().setContent(content)
  const container = new ContainerBuilder().setAccentColor(0x95a5a6)

  const thumbnailUrl = input.track !== undefined ? resolveThumbnail(input.track) : undefined
  if (input.track !== undefined && thumbnailUrl !== undefined) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(textDisplay)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl).setDescription(input.track.title))
    container.addSectionComponents(section)
  } else {
    container.addTextDisplayComponents(textDisplay)
  }

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  }
}
