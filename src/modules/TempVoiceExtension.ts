import { config } from '../config'
import { CommandAccessError } from '../domain/errors'
import {
  type ControlPanelState,
  TVCTL_ACTIONS,
  TVCTL_MODALS,
  TVCTL_MODAL_PREFIX,
  TVCTL_PREFIX,
  buildControlPanel,
  buildKickReasonMessage,
  buildKickReasonModal,
  buildLimitModal,
  buildRenameModal,
  buildStatusModal,
  buildUserSelectMessage,
  kickReasonLabel,
} from '../features/tempVoice/tempVoiceControlPanel'
import {
  type TempVoiceRoom,
  createRoomRecord,
  deleteRoomRecord,
  getRoom,
  getRoomByOwner,
  isTempRoom,
  listAllRooms,
  listGuildRooms,
  loadTempVoiceRooms,
  markCreated,
  pickNextOwner,
  remainingCooldownSeconds,
  updateRoomRecord,
} from '../features/tempVoice/tempVoiceRooms'
import {
  type TempVoiceSettings,
  commitDraft,
  discardDraft,
  getDraftTempVoiceSettings,
  getTempVoiceSettings,
  hasDraft,
  loadTempVoiceSettings,
  updateDraft,
} from '../features/tempVoice/tempVoiceSettings'
import {
  TVSET_ACTIONS,
  TVSET_MODALS,
  TVSET_MODAL_PREFIX,
  TVSET_PREFIX,
  buildCancelledPanel,
  buildExpiredPanel,
  buildSavedPanel,
  buildTempVoicePanel,
  buildTemplateModal,
} from '../features/tempVoice/tempVoiceSettingsPanel'
import { logger } from '../utils/logger'
import { requireServerManager } from '../utils/permissions'
import { dismissTtsBot, summonTtsBot } from './TtsExtension'
import { Extension, applicationCommand, listener } from '@pikokr/command.ts'
import { Routes } from 'discord-api-types/v10'
// @pikokr/command.ts는 design:paramtypes 리플렉션으로 @applicationCommand
// 핸들러에 인터랙션을 주입한다. 따라서 ChatInputCommandInteraction은 반드시
// 값 import여야 하며, `type`을 붙이면 컴파일 시 소거돼 i가 undefined가 된다.
import {
  ApplicationCommandType,
  ChannelType,
  ChatInputCommandInteraction,
  type DMChannel,
  EmbedBuilder,
  type GuildBasedChannel,
  type GuildMember,
  type Interaction,
  type Message,
  type MessageComponentInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  type VoiceBasedChannel,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js'

const SETTINGS_SESSION_TIMEOUT_MS = 3 * 60 * 1000
// 재시작 직후 빈 것처럼 보이는 방을 바로 지우지 않고 재확인하는 지연.
// clientReady 시점에 voice-state 캐시가 늦게 차는 경우 실사용 방 삭제를 막는다.
const STARTUP_EMPTY_RECHECK_MS = 30 * 1000
// '➕ 생성 채널 새로 만들기'로 자동 생성되는 생성 채널 기본 이름.
const GENERATOR_CHANNEL_NAME = '➕ 통화방 만들기'
const OWNER_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.Stream,
]

type SettingsSession = {
  message: Message
  timeout: NodeJS.Timeout
}

class TempVoiceExtensionClass extends Extension {
  private loaded = false
  // 방장이 나간 뒤 자동 위임까지의 유예 타이머 (channelId -> timer)
  private readonly graceTimers = new Map<string, NodeJS.Timeout>()
  // 방에 들어온 순서 추적 (channelId -> userId -> joinedAt ms)
  private readonly joinTimes = new Map<string, Map<string, number>>()
  // 컨트롤 패널 메시지 id (channelId -> messageId)
  private readonly controlMessages = new Map<string, string>()
  // 채널 상태 문구(재시작 시 유실 허용) (channelId -> status)
  private readonly roomStatus = new Map<string, string>()
  // /통화방설정 패널 세션 (guildId -> session)
  private readonly settingsSessions = new Map<string, SettingsSession>()
  // 방 생성 진행 중인 유저 (guildId:userId) — 이벤트 중복 수신 시 중복 생성/쿨다운 우회 방지
  private readonly creatingRooms = new Set<string>()
  // 설정 중 자동 생성한 생성 채널 (guildId -> channelId). 저장 없이 취소하면 삭제한다.
  private readonly autoCreatedGenerator = new Map<string, string>()

  // ─── 부팅/복구 ───

  @listener({ event: 'clientReady' })
  async ready(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    try {
      await loadTempVoiceSettings()
      await loadTempVoiceRooms()
      await this.reconcileRooms()
    } catch (err) {
      logger.error(
        'TempVoice',
        `초기화 실패: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /** 재시작 후 DB의 활성 통화방을 실제 채널 상태와 대조해 정리한다. */
  private async reconcileRooms(): Promise<void> {
    for (const room of listAllRooms()) {
      const guild = this.client.guilds.cache.get(room.guildId)
      if (guild === undefined) continue

      const channel = this.getVoiceChannel(room.guildId, room.channelId)
      if (channel === null) {
        await deleteRoomRecord(room.channelId)
        continue
      }

      const humans = this.humanMembers(channel)
      if (humans.length === 0) {
        // 즉시 삭제하면 아직 하이드레이트 안 된 실사용 방을 끊을 수 있어
        // 잠시 뒤 다시 확인한다. 그동안 방은 정상 이벤트로도 관리된다.
        setTimeout(() => {
          void this.verifyStartupRoom(room.channelId)
        }, STARTUP_EMPTY_RECHECK_MS)
        continue
      }

      await this.integrateExistingRoom(channel, room.ownerId, humans)
    }
  }

  /** 재시작 재확인: 아직도 비었으면 삭제, 사람이 있으면 정상 방으로 편입. */
  private async verifyStartupRoom(channelId: string): Promise<void> {
    const room = getRoom(channelId)
    if (room === undefined) return

    const channel = this.getVoiceChannel(room.guildId, channelId)
    if (channel === null) {
      await deleteRoomRecord(channelId)
      this.clearRoomState(channelId)
      return
    }

    const humans = this.humanMembers(channel)
    if (humans.length === 0) {
      await this.destroyRoom(channelId, channel)
      return
    }
    await this.integrateExistingRoom(channel, room.ownerId, humans)
  }

  /** 재시작으로 되살린 방을 in-memory 상태에 편입한다(순서 재시드·패널·위임). */
  private async integrateExistingRoom(
    channel: VoiceChannel,
    ownerId: string,
    humans: string[]
  ): Promise<void> {
    // 입장 순서 정보는 유실됐으니 현재 인원을 동시 진입으로 간주해 재시드.
    const now = Date.now()
    const map = new Map<string, number>()
    for (const id of humans) map.set(id, now)
    this.joinTimes.set(channel.id, map)

    await this.refreshControlPanel(channel)

    if (!humans.includes(ownerId)) {
      const settings = await getTempVoiceSettings(channel.guild.id)
      this.scheduleOwnerDelegate(channel.id, settings.ownerGraceMinutes)
    }
  }

  // ─── 음성 상태 변화 ───

  @listener({ event: 'voiceStateUpdate' })
  async onVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState
  ): Promise<void> {
    const member = newState.member ?? oldState.member
    if (member === null) return

    const oldId = oldState.channelId
    const newId = newState.channelId
    if (oldId === newId) return // 음소거/화면공유 등 채널 이동이 아닌 변화

    // TTS 봇의 입/퇴장이면 해당 통화방 패널의 TTS 버튼 라벨만 갱신하고 끝낸다.
    const ttsId = config.tts?.clientId
    if (ttsId !== undefined && ttsId.length > 0 && member.id === ttsId) {
      await this.refreshTtsButton(oldId, newId)
      return
    }

    if (member.user.bot) return

    const guild = newState.guild
    const settings = await getTempVoiceSettings(guild.id)

    try {
      // 1) 임시 통화방에서 나감 → 빈 방 정리 또는 방장 이탈 유예
      if (oldId !== null && isTempRoom(oldId)) {
        await this.handleLeftRoom(oldId, member.id, settings)
      }

      // 2) 생성 채널 입장 → 통화방 생성/이동
      if (
        newId !== null &&
        settings.enabled &&
        settings.generatorChannelId !== null &&
        newId === settings.generatorChannelId
      ) {
        await this.handleGeneratorJoin(newState, settings)
        return
      }

      // 3) 임시 통화방 입장 → 순서 기록/방장 복귀 처리
      if (newId !== null && isTempRoom(newId)) {
        this.handleJoinedRoom(newId, member.id)
      }
    } catch (err) {
      logger.error(
        'TempVoice',
        `음성 상태 처리 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  @listener({ event: 'channelDelete' })
  async onChannelDelete(channel: DMChannel | GuildBasedChannel): Promise<void> {
    if (!isTempRoom(channel.id)) return
    // 채널이 수동으로 삭제됨 → 기록/타이머 정리 (채널 자체는 이미 없음)
    this.clearRoomState(channel.id)
    await deleteRoomRecord(channel.id)
  }

  private async handleLeftRoom(
    channelId: string,
    memberId: string,
    settings: TempVoiceSettings
  ): Promise<void> {
    const room = getRoom(channelId)
    if (room === undefined) return

    const channel = this.getVoiceChannel(room.guildId, channelId)
    this.joinTimes.get(channelId)?.delete(memberId)

    const humans = channel === null ? [] : this.humanMembers(channel)
    if (humans.length === 0) {
      await this.destroyRoom(channelId, channel)
      return
    }

    if (memberId === room.ownerId) {
      this.scheduleOwnerDelegate(channelId, settings.ownerGraceMinutes)
    }
  }

  private handleJoinedRoom(channelId: string, memberId: string): void {
    const map = this.joinTimes.get(channelId) ?? new Map<string, number>()
    if (!map.has(memberId)) map.set(memberId, Date.now())
    this.joinTimes.set(channelId, map)

    const room = getRoom(channelId)
    if (room !== undefined && memberId === room.ownerId) {
      // 방장이 유예 시간 안에 돌아옴 → 자동 위임 취소
      this.cancelGrace(channelId)
    }
  }

  private async handleGeneratorJoin(
    state: VoiceState,
    settings: TempVoiceSettings
  ): Promise<void> {
    const member = state.member
    if (member === null) return
    const guild = state.guild

    // 같은 유저의 생성 이벤트가 await 구간에 중복 도착하면(빠른 재접속/게이트웨이
    // RESUME 등) 방이 2개 생성되고 쿨다운이 우회된다. 진입 즉시(첫 await 이전)
    // 잠금을 걸고 finally에서 해제한다.
    const lockKey = `${guild.id}:${member.id}`
    if (this.creatingRooms.has(lockKey)) return
    this.creatingRooms.add(lockKey)
    try {
      // 이미 자기 통화방이 있으면 새로 만들지 않고 그 방으로 이동.
      const existing = getRoomByOwner(guild.id, member.id)
      if (existing !== undefined) {
        const existingChannel = this.getVoiceChannel(
          guild.id,
          existing.channelId
        )
        if (existingChannel !== null) {
          await member.voice.setChannel(existingChannel).catch(() => undefined)
          return
        }
        await deleteRoomRecord(existing.channelId)
      }

      // 연속 생성 방지 쿨다운.
      const now = Date.now()
      const remain = remainingCooldownSeconds(
        guild.id,
        member.id,
        settings.cooldownSeconds,
        now
      )
      if (remain > 0) {
        await this.notifyCooldown(state, remain)
        return
      }

      // 통화방 생성.
      const generator = this.getVoiceChannel(
        guild.id,
        settings.generatorChannelId ?? ''
      )
      const parentId = settings.categoryId ?? generator?.parentId ?? null
      const count = listGuildRooms(guild.id).length + 1
      const name = renderRoomName(
        settings.nameTemplate,
        member.displayName,
        count
      )

      let created: VoiceChannel
      try {
        created = await guild.channels.create({
          name,
          type: ChannelType.GuildVoice,
          parent: parentId ?? undefined,
          userLimit:
            settings.defaultUserLimit > 0
              ? settings.defaultUserLimit
              : undefined,
          permissionOverwrites: [{ id: member.id, allow: OWNER_ALLOW }],
          reason: `임시 통화방 생성 (${member.user.tag})`,
        })
      } catch (err) {
        logger.error(
          'TempVoice',
          `통화방 생성 실패: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        await this.notifyGenerator(
          state,
          `<@${member.id}>님, 통화방을 만들지 못했어요. 봇의 채널 관리·멤버 이동 권한이나 서버 채널 수 제한을 확인해 주세요.`
        )
        return
      }

      // 생성한 방으로 이동. 실패(이미 나감 등)하면 방을 롤백 삭제.
      try {
        await member.voice.setChannel(created)
      } catch {
        await created
          .delete('임시 통화방 이동 실패 롤백')
          .catch(() => undefined)
        return
      }

      markCreated(guild.id, member.id, now)
      await createRoomRecord({
        channelId: created.id,
        guildId: guild.id,
        ownerId: member.id,
        createdBy: member.id,
        createdAt: now,
      })
      this.joinTimes.set(created.id, new Map([[member.id, now]]))

      const room = getRoom(created.id)
      if (room !== undefined) {
        await this.postControlPanel(created, room)
      }

      logger.info(
        'TempVoice',
        `${guild.name} - ${member.user.tag} 통화방 생성 (#${created.name})`
      )
      void this.logTempVoice(guild.id, {
        emoji: '🆕',
        title: '통화방 생성',
        color: 0x2ecc71,
        lines: [
          `방장: <@${member.id}> (${member.user.tag})`,
          `채널: **${created.name}**`,
        ],
      })
    } finally {
      this.creatingRooms.delete(lockKey)
    }
  }

  private async notifyCooldown(
    state: VoiceState,
    remain: number
  ): Promise<void> {
    const member = state.member
    if (member === null) return
    await this.notifyGenerator(
      state,
      `<@${member.id}>님, 통화방을 너무 빠르게 다시 만들 수 없어요. **${remain}초** 뒤에 다시 시도해 주세요.`
    )
  }

  /** 생성 채널(텍스트-in-보이스)에 자동 삭제되는 안내를 best-effort로 보낸다. */
  private async notifyGenerator(
    state: VoiceState,
    content: string
  ): Promise<void> {
    const channel = state.channel
    if (channel === null || !channel.isTextBased()) return
    const userId = state.member?.id

    try {
      const msg = await channel.send({
        content,
        allowedMentions:
          userId !== undefined ? { users: [userId] } : { parse: [] },
      })
      setTimeout(() => {
        msg.delete().catch(() => undefined)
      }, 15000)
    } catch {
      // 텍스트 전송 권한이 없으면 조용히 무시.
    }
  }

  // ─── 방장 자동 위임 ───

  private scheduleOwnerDelegate(channelId: string, graceMinutes: number): void {
    this.cancelGrace(channelId)
    if (graceMinutes <= 0) {
      void this.delegateOwner(channelId)
      return
    }
    const handle = setTimeout(() => {
      void this.delegateOwner(channelId)
    }, graceMinutes * 60 * 1000)
    this.graceTimers.set(channelId, handle)
  }

  private cancelGrace(channelId: string): void {
    const handle = this.graceTimers.get(channelId)
    if (handle !== undefined) {
      clearTimeout(handle)
      this.graceTimers.delete(channelId)
    }
  }

  private async delegateOwner(channelId: string): Promise<void> {
    this.graceTimers.delete(channelId)
    const room = getRoom(channelId)
    if (room === undefined) return

    const channel = this.getVoiceChannel(room.guildId, channelId)
    if (channel === null) {
      // 유예 중 채널이 사라짐 → 레코드/상태 정리(누수 방지).
      await deleteRoomRecord(channelId)
      this.clearRoomState(channelId)
      return
    }

    const humans = this.humanMembers(channel)
    if (humans.length === 0) {
      await this.destroyRoom(channelId, channel)
      return
    }
    // 방장이 이미 돌아왔으면 위임 취소.
    if (humans.includes(room.ownerId)) return

    const next = pickNextOwner(
      humans,
      room.ownerId,
      this.joinTimes.get(channelId) ?? new Map()
    )
    if (next === null) return

    const prevOwner = room.ownerId
    await this.applyOwnership(channel, next)
    await channel
      .send(
        `👑 이전 방장이 돌아오지 않아 <@${next}>님에게 방장이 자동으로 넘어갔어요.`
      )
      .catch(() => undefined)
    void this.logTempVoice(room.guildId, {
      emoji: '👑',
      title: '방장 자동 위임',
      color: 0xf39c12,
      lines: [
        `통화방: **${channel.name}**`,
        `이전: <@${prevOwner}> → <@${next}>`,
        '사유: 이전 방장이 유예 시간 안에 돌아오지 않음',
      ],
    })
  }

  private async applyOwnership(
    channel: VoiceChannel,
    newOwnerId: string
  ): Promise<void> {
    const previousOwnerId = getRoom(channel.id)?.ownerId
    await updateRoomRecord(channel.id, { ownerId: newOwnerId })
    await channel.permissionOverwrites
      .edit(newOwnerId, {
        ViewChannel: true,
        Connect: true,
        Speak: true,
        Stream: true,
      })
      .catch(() => undefined)
    // 이전 방장의 개인 overwrite(잠금 우회용 Connect allow)를 제거한다.
    // 안 지우면 멤버별 allow가 @everyone의 Connect deny를 이겨 잠금이 무력화된다.
    if (previousOwnerId !== undefined && previousOwnerId !== newOwnerId) {
      await channel.permissionOverwrites
        .delete(previousOwnerId, '이전 방장 권한 정리')
        .catch(() => undefined)
    }
    await this.refreshControlPanel(channel)
  }

  // ─── 통화방 정리 ───

  private async destroyRoom(
    channelId: string,
    channel: VoiceBasedChannel | null
  ): Promise<void> {
    const room = getRoom(channelId)
    const guildId = room?.guildId ?? channel?.guild.id ?? null
    const roomName = channel?.name ?? channelId

    this.clearRoomState(channelId)
    await deleteRoomRecord(channelId)
    if (channel !== null) {
      await channel.delete('임시 통화방 정리 (빈 방)').catch(() => undefined)
    }
    if (guildId !== null) {
      void this.logTempVoice(guildId, {
        emoji: '🗑️',
        title: '통화방 삭제',
        color: 0x95a5a6,
        lines: [`채널: **${roomName}**`, '사유: 비어서 자동 삭제'],
      })
    }
  }

  private clearRoomState(channelId: string): void {
    this.cancelGrace(channelId)
    this.joinTimes.delete(channelId)
    this.controlMessages.delete(channelId)
    this.roomStatus.delete(channelId)
  }

  // ─── 컨트롤 패널 ───

  private async postControlPanel(
    channel: VoiceChannel,
    room: TempVoiceRoom
  ): Promise<void> {
    try {
      const msg = await channel.send(
        buildControlPanel(this.buildPanelState(channel, room))
      )
      this.controlMessages.set(channel.id, msg.id)
    } catch (err) {
      logger.warn(
        'TempVoice',
        `컨트롤 패널 전송 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  private async refreshControlPanel(channel: VoiceChannel): Promise<void> {
    const room = getRoom(channel.id)
    if (room === undefined) return
    const payload = buildControlPanel(this.buildPanelState(channel, room))

    const msgId = this.controlMessages.get(channel.id)
    if (msgId !== undefined) {
      const msg = await channel.messages.fetch(msgId).catch(() => null)
      if (msg !== null) {
        await msg.edit(payload).catch(() => undefined)
        return
      }
    }
    // 저장된 패널 메시지가 없으면(재시작 등) 새로 게시.
    const fresh = await channel.send(payload).catch(() => null)
    if (fresh !== null) this.controlMessages.set(channel.id, fresh.id)
  }

  private buildPanelState(
    channel: VoiceChannel,
    room: TempVoiceRoom
  ): ControlPanelState {
    return {
      channelName: channel.name,
      ownerId: room.ownerId,
      locked: room.locked,
      userLimit: channel.userLimit,
      status: this.roomStatus.get(channel.id) ?? null,
      ttsActive: this.ttsInRoom(channel),
    }
  }

  /** TTS 봇이 통화방을 드나들면 그 방(들)의 컨트롤 패널을 갱신해 버튼 라벨을 맞춘다. */
  private async refreshTtsButton(
    oldId: string | null,
    newId: string | null
  ): Promise<void> {
    const seen = new Set<string>()
    for (const id of [oldId, newId]) {
      if (id === null || seen.has(id) || !isTempRoom(id)) continue
      seen.add(id)
      const room = getRoom(id)
      if (room === undefined) continue
      const channel = this.getVoiceChannel(room.guildId, id)
      if (channel !== null) await this.refreshControlPanel(channel)
    }
  }

  // ─── 로그 ───

  /** 설정된 로그 채널에 통화방 이벤트를 임베드로 남긴다(미설정 시 무시). */
  private async logTempVoice(
    guildId: string,
    opts: {
      emoji: string
      title: string
      color: number
      lines: (string | null)[]
    }
  ): Promise<void> {
    const settings = await getTempVoiceSettings(guildId)
    if (settings.logChannelId === null) return
    const guild = this.client.guilds.cache.get(guildId)
    const channel = guild?.channels.cache.get(settings.logChannelId)
    if (
      channel === undefined ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement)
    ) {
      return
    }
    const embed = new EmbedBuilder()
      .setColor(opts.color)
      .setTitle(`${opts.emoji} ${opts.title}`)
      .setDescription(
        opts.lines.filter((line): line is string => line !== null).join('\n')
      )
      .setTimestamp()
    await channel.send({ embeds: [embed] }).catch(() => undefined)
  }

  // ─── 슬래시 커맨드 ───

  @applicationCommand({
    name: '통화방설정',
    type: ApplicationCommandType.ChatInput,
    description: '임시 통화방(자동 생성) 기능을 설정합니다.',
  })
  async settingsCommand(i: ChatInputCommandInteraction): Promise<void> {
    // requireServerManager는 CommandAccessError를 던지지만 전역 invokeError
    // 핸들러는 로그만 남긴다 — 여기서 흡수해 거부 사유를 ephemeral로 응답한다.
    try {
      requireServerManager(i)
    } catch (err) {
      if (err instanceof CommandAccessError) {
        await i.reply({
          content: err.messageForUser,
          flags: MessageFlags.Ephemeral,
        })
        return
      }
      throw err
    }
    if (i.guild === null) return

    const draft = getDraftTempVoiceSettings(i.guild.id)
    await i.reply(buildTempVoicePanel(draft, hasDraft(i.guild.id)))
    const message = await i.fetchReply().catch(() => null)
    if (message !== null) this.registerSettingsSession(i.guild.id, message)
  }

  // ─── 인터랙션 라우팅 ───

  @listener({ event: 'interactionCreate' })
  async onInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith(TVSET_MODAL_PREFIX)) {
          await this.handleSettingsModal(interaction)
        } else if (interaction.customId.startsWith(TVCTL_MODAL_PREFIX)) {
          await this.handleControlModal(interaction)
        }
        return
      }

      if (interaction.isMessageComponent()) {
        if (interaction.customId.startsWith(TVSET_PREFIX)) {
          await this.handleSettingsComponent(interaction)
        } else if (interaction.customId.startsWith(TVCTL_PREFIX)) {
          await this.handleControlComponent(interaction)
        }
      }
    } catch (err) {
      logger.error(
        'TempVoice',
        `인터랙션 처리 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  // ─── 설정 패널 처리 ───

  private async handleSettingsComponent(
    interaction: MessageComponentInteraction
  ): Promise<void> {
    if (interaction.guild === null) return
    if (!memberCanManage(interaction)) {
      await interaction.reply({
        content: '서버 관리 권한이 있는 사용자만 설정을 바꿀 수 있어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const guildId = interaction.guild.id
    const action = interaction.customId.slice(TVSET_PREFIX.length)

    if (action === TVSET_ACTIONS.editTemplate && interaction.isButton()) {
      await interaction.showModal(
        buildTemplateModal(getDraftTempVoiceSettings(guildId))
      )
      return
    }

    if (action === TVSET_ACTIONS.save && interaction.isButton()) {
      const draft = getDraftTempVoiceSettings(guildId)
      if (draft.enabled && draft.generatorChannelId === null) {
        await interaction.reply({
          content:
            '생성 채널이 없어 활성화 상태로 저장할 수 없어요. 채널을 고르거나 "➕ 생성 채널 새로 만들기"를 눌러 주세요.',
          flags: MessageFlags.Ephemeral,
        })
        return
      }
      const settings = await commitDraft(guildId)
      this.autoCreatedGenerator.delete(guildId)
      await interaction.update(buildSavedPanel(settings))
      this.clearSettingsSession(guildId)
      return
    }

    if (action === TVSET_ACTIONS.cancel && interaction.isButton()) {
      discardDraft(guildId)
      await this.cleanupAutoCreatedGenerator(guildId)
      await interaction.update(buildCancelledPanel())
      this.clearSettingsSession(guildId)
      return
    }

    if (action === TVSET_ACTIONS.createGenerator && interaction.isButton()) {
      await this.handleCreateGenerator(interaction, guildId)
      return
    }

    if (
      action === TVSET_ACTIONS.generator &&
      interaction.isChannelSelectMenu()
    ) {
      const id = interaction.values[0] ?? null
      // 채널을 지정하면 자동 활성화, 비우면 자동 비활성화(활성인데 생성 채널
      // 없는 모순 상태 방지).
      updateDraft(guildId, {
        generatorChannelId: id,
        enabled: id !== null,
      })
    } else if (
      action === TVSET_ACTIONS.category &&
      interaction.isChannelSelectMenu()
    ) {
      updateDraft(guildId, { categoryId: interaction.values[0] ?? null })
    } else if (
      action === TVSET_ACTIONS.logChannel &&
      interaction.isChannelSelectMenu()
    ) {
      updateDraft(guildId, { logChannelId: interaction.values[0] ?? null })
    } else if (
      action === TVSET_ACTIONS.grace &&
      interaction.isStringSelectMenu()
    ) {
      const minutes = Number(interaction.values[0])
      if (Number.isFinite(minutes)) {
        updateDraft(guildId, { ownerGraceMinutes: minutes })
      }
    } else if (action === TVSET_ACTIONS.toggle && interaction.isButton()) {
      const current = getDraftTempVoiceSettings(guildId)
      if (!current.enabled && current.generatorChannelId === null) {
        await interaction.reply({
          content:
            '먼저 생성 채널을 지정하거나 "➕ 생성 채널 새로 만들기"를 눌러 주세요.',
          flags: MessageFlags.Ephemeral,
        })
        return
      }
      updateDraft(guildId, { enabled: !current.enabled })
    }

    await interaction.update(
      buildTempVoicePanel(getDraftTempVoiceSettings(guildId), true)
    )
    this.refreshSettingsSession(guildId, interaction)
  }

  /** '➕ 생성 채널 새로 만들기' — 카테고리(있으면) 안에 음성 채널을 만들고 생성 채널로 지정한다. */
  private async handleCreateGenerator(
    interaction: MessageComponentInteraction,
    guildId: string
  ): Promise<void> {
    if (!interaction.isButton()) return
    const guild = interaction.guild
    if (guild === null) return

    const draft = getDraftTempVoiceSettings(guildId)
    if (draft.generatorChannelId !== null) {
      await interaction.update(buildTempVoicePanel(draft, true))
      return
    }

    let created: VoiceChannel
    try {
      created = await guild.channels.create({
        name: GENERATOR_CHANNEL_NAME,
        type: ChannelType.GuildVoice,
        parent: draft.categoryId ?? undefined,
        reason: '임시 통화방 생성 채널(Join-to-Create) 자동 생성',
      })
    } catch (err) {
      await interaction.reply({
        content: `생성 채널을 만들지 못했어요: ${
          err instanceof Error ? err.message : String(err)
        }. 봇의 채널 관리 권한을 확인해 주세요.`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    this.autoCreatedGenerator.set(guildId, created.id)
    updateDraft(guildId, { generatorChannelId: created.id, enabled: true })
    await interaction.update(
      buildTempVoicePanel(getDraftTempVoiceSettings(guildId), true)
    )
    this.refreshSettingsSession(guildId, interaction)
  }

  /** 저장 없이 취소되면, 이번 세션에 자동 생성한 생성 채널을 되돌려 삭제한다. */
  private async cleanupAutoCreatedGenerator(guildId: string): Promise<void> {
    const channelId = this.autoCreatedGenerator.get(guildId)
    if (channelId === undefined) return
    this.autoCreatedGenerator.delete(guildId)
    const channel = this.getVoiceChannel(guildId, channelId)
    if (channel !== null) {
      await channel
        .delete('통화방 설정 취소 — 자동 생성 채널 정리')
        .catch(() => undefined)
    }
  }

  private async handleSettingsModal(
    interaction: ModalSubmitInteraction
  ): Promise<void> {
    if (interaction.guild === null || !interaction.isFromMessage()) return
    if (!memberCanManage(interaction)) {
      await interaction.reply({
        content: '서버 관리 권한이 있는 사용자만 설정을 바꿀 수 있어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const guildId = interaction.guild.id
    const kind = interaction.customId.slice(TVSET_MODAL_PREFIX.length)
    if (kind !== TVSET_MODALS.template) return

    const template = interaction.fields.getTextInputValue('template').trim()
    const limit = clampNumber(
      interaction.fields.getTextInputValue('limit'),
      0,
      99,
      0
    )
    const cooldown = clampNumber(
      interaction.fields.getTextInputValue('cooldown'),
      0,
      600,
      30
    )

    updateDraft(guildId, {
      nameTemplate: template.length > 0 ? template : undefined,
      defaultUserLimit: limit,
      cooldownSeconds: cooldown,
    })

    await interaction.update(
      buildTempVoicePanel(getDraftTempVoiceSettings(guildId), true)
    )
    this.refreshSettingsSession(guildId, interaction)
  }

  // ─── 설정 세션(자동 저장) ───

  private registerSettingsSession(guildId: string, message: Message): void {
    this.clearSettingsSession(guildId)
    const timeout = setTimeout(() => {
      void this.expireSettingsSession(guildId)
    }, SETTINGS_SESSION_TIMEOUT_MS)
    this.settingsSessions.set(guildId, { message, timeout })
  }

  private refreshSettingsSession(
    guildId: string,
    interaction: MessageComponentInteraction | ModalSubmitInteraction
  ): void {
    const message =
      interaction.message ?? this.settingsSessions.get(guildId)?.message
    if (message === null || message === undefined) return
    this.registerSettingsSession(guildId, message)
  }

  private clearSettingsSession(guildId: string): void {
    const session = this.settingsSessions.get(guildId)
    if (session !== undefined) clearTimeout(session.timeout)
    this.settingsSessions.delete(guildId)
  }

  private async expireSettingsSession(guildId: string): Promise<void> {
    const session = this.settingsSessions.get(guildId)
    this.settingsSessions.delete(guildId)
    if (session === undefined) return
    if (!hasDraft(guildId)) return

    const settings = await commitDraft(guildId)
    // 자동 저장으로 확정됐으니 자동 생성 채널은 유지(추적만 해제).
    this.autoCreatedGenerator.delete(guildId)
    await session.message
      .edit(buildExpiredPanel(settings))
      .catch(() => undefined)
  }

  // ─── 컨트롤 패널 처리 ───

  private async handleControlComponent(
    interaction: MessageComponentInteraction
  ): Promise<void> {
    if (interaction.guild === null) return
    const channelId = interaction.channelId
    const room = getRoom(channelId)
    if (room === undefined) {
      await interaction.reply({
        content: '이 통화방은 더 이상 관리할 수 없어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    const channel = this.getVoiceChannel(interaction.guild.id, channelId)
    if (channel === null) return
    const action = interaction.customId.slice(TVCTL_PREFIX.length)

    // TTS 부르기는 통화방에 있는 누구나 사용 가능(방장 전용 게이트 이전에 처리).
    if (action === TVCTL_ACTIONS.tts) {
      await this.handleSummonTts(interaction, channel)
      return
    }

    if (!this.canControl(interaction, room)) {
      await interaction.reply({
        content:
          '통화방에 들어와 있는 방장(또는 서버 관리자)만 조작할 수 있어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    // 내보내기 사유 선택(대상 id를 customId에 실어 보냄): tvctl:kickReason:<targetId>
    if (action.startsWith(`${TVCTL_ACTIONS.kickReason}:`)) {
      const targetId = action.slice(`${TVCTL_ACTIONS.kickReason}:`.length)
      await this.doKickReason(interaction, channel, room, targetId)
      return
    }

    switch (action) {
      case TVCTL_ACTIONS.rename:
        if (interaction.isButton())
          await interaction.showModal(buildRenameModal(channel.name))
        return
      case TVCTL_ACTIONS.status:
        if (interaction.isButton())
          await interaction.showModal(
            buildStatusModal(this.roomStatus.get(channelId) ?? null)
          )
        return
      case TVCTL_ACTIONS.limit:
        if (interaction.isButton())
          await interaction.showModal(buildLimitModal(channel.userLimit))
        return
      case TVCTL_ACTIONS.lock:
        await this.toggleLock(interaction, channel, room)
        return
      case TVCTL_ACTIONS.transfer:
        await this.openUserSelect(
          interaction,
          TVCTL_ACTIONS.transferSel,
          '방장을 넘길 사람을 선택하세요. (통화방에 있는 사람만 가능)'
        )
        return
      case TVCTL_ACTIONS.kick:
        await this.openUserSelect(
          interaction,
          TVCTL_ACTIONS.kickSel,
          '통화방에서 내보낼 사람을 선택하세요.'
        )
        return
      case TVCTL_ACTIONS.transferSel:
        await this.doTransfer(interaction, channel, room)
        return
      case TVCTL_ACTIONS.kickSel:
        await this.doKickShowReason(interaction, channel, room)
        return
    }
  }

  private async handleControlModal(
    interaction: ModalSubmitInteraction
  ): Promise<void> {
    if (interaction.guild === null || !interaction.isFromMessage()) return
    const channelId = interaction.channelId
    if (channelId === null) return
    const room = getRoom(channelId)
    if (room === undefined) {
      await interaction.reply({
        content: '이 통화방은 더 이상 관리할 수 없어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    if (!this.canControl(interaction, room)) {
      await interaction.reply({
        content:
          '통화방에 들어와 있는 방장(또는 서버 관리자)만 조작할 수 있어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const channel = this.getVoiceChannel(interaction.guild.id, channelId)
    if (channel === null) return
    const kind = interaction.customId.slice(TVCTL_MODAL_PREFIX.length)
    const value = interaction.fields.getTextInputValue('value')

    // 내보내기 사유 직접 입력: tvctlModal:kickReason:<targetId>
    if (kind.startsWith(`${TVCTL_MODALS.kickReason}:`)) {
      const targetId = kind.slice(`${TVCTL_MODALS.kickReason}:`.length)
      const reason = value.trim()
      if (reason.length === 0) {
        await interaction.reply({
          content: '사유를 입력해 주세요.',
          flags: MessageFlags.Ephemeral,
        })
        return
      }
      const result = await this.performKick(
        channel,
        room,
        targetId,
        reason,
        interaction.user.id
      )
      await interaction.update({ content: result, components: [] })
      return
    }

    if (kind === TVCTL_MODALS.rename) {
      const name = value.trim().slice(0, 100)
      if (name.length === 0) {
        await interaction.reply({
          content: '이름은 비워둘 수 없어요.',
          flags: MessageFlags.Ephemeral,
        })
        return
      }
      const oldName = channel.name
      try {
        await channel.setName(name, '방장 이름 변경')
      } catch {
        await interaction.reply({
          content:
            '이름을 바꾸지 못했어요. 디스코드는 채널 이름을 10분에 2번까지만 바꿀 수 있어요. 잠시 후 다시 시도해 주세요.',
          flags: MessageFlags.Ephemeral,
        })
        return
      }
      void this.logTempVoice(channel.guild.id, {
        emoji: '✏️',
        title: '통화방 이름 변경',
        color: 0x1abc9c,
        lines: [
          `이전: **${oldName}** → **${name}**`,
          `처리: <@${interaction.user.id}>`,
        ],
      })
    } else if (kind === TVCTL_MODALS.status) {
      const status = value.trim()
      try {
        await this.client.rest.put(Routes.channelVoiceStatus(channelId), {
          body: { status: status.length > 0 ? status : null },
        })
        if (status.length > 0) this.roomStatus.set(channelId, status)
        else this.roomStatus.delete(channelId)
      } catch {
        await interaction.reply({
          content: '상태를 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.',
          flags: MessageFlags.Ephemeral,
        })
        return
      }
    } else if (kind === TVCTL_MODALS.limit) {
      const limit = clampNumber(value, 0, 99, channel.userLimit)
      await channel
        .setUserLimit(limit, '방장 인원 제한 변경')
        .catch(() => undefined)
    } else {
      return
    }

    await interaction.update(
      buildControlPanel(this.buildPanelState(channel, room))
    )
  }

  // ─── 컨트롤 액션 ───

  private async toggleLock(
    interaction: MessageComponentInteraction,
    channel: VoiceChannel,
    room: TempVoiceRoom
  ): Promise<void> {
    const locked = !room.locked
    const everyoneId = channel.guild.roles.everyone.id
    try {
      await channel.permissionOverwrites.edit(
        everyoneId,
        { Connect: locked ? false : null },
        { reason: locked ? '통화방 잠금' : '통화방 잠금 해제' }
      )
    } catch {
      await interaction.reply({
        content: '잠금 상태를 바꾸지 못했어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    await updateRoomRecord(channel.id, { locked })
    await interaction.update(
      buildControlPanel(this.buildPanelState(channel, room))
    )
    void this.logTempVoice(channel.guild.id, {
      emoji: locked ? '🔒' : '🔓',
      title: locked ? '통화방 잠금' : '통화방 잠금 해제',
      color: 0x9b59b6,
      lines: [`통화방: **${channel.name}**`, `처리: <@${interaction.user.id}>`],
    })
  }

  /** TTS 봇이 이 통화방(음성 채널)에 접속해 있는지. clientId 미설정 시 항상 false. */
  private ttsInRoom(channel: VoiceChannel): boolean {
    const ttsId = config.tts?.clientId
    if (ttsId === undefined || ttsId.length === 0) return false
    return channel.members.has(ttsId)
  }

  /** '🔊 TTS' 토글 — 방에 있으면 내보내고, 없으면 부른다(방에 있는 누구나). */
  private async handleSummonTts(
    interaction: MessageComponentInteraction,
    channel: VoiceChannel
  ): Promise<void> {
    if (!interaction.isButton()) return
    if (!channel.members.has(interaction.user.id)) {
      await interaction.reply({
        content: '통화방에 들어와 있어야 TTS를 부를 수 있어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const active = this.ttsInRoom(channel)
    // 입장은 음성 Ready 대기까지 최대 ~20초 걸릴 수 있어 먼저 defer한다.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const result = active
      ? await dismissTtsBot(channel.guild.id)
      : await summonTtsBot(channel.guild.id, channel.id, channel.id)

    if (result.ok) {
      await interaction.editReply({
        content: active
          ? '🔇 TTS 봇을 통화방에서 내보냈어요.'
          : '🔊 TTS 봇을 불렀어요. 이제 통화방 채팅을 읽어드려요.',
      })
      // 버튼 라벨은 TTS 봇의 실제 입/퇴장(voiceStateUpdate)으로 갱신된다.
      return
    }
    await interaction.editReply({
      content: result.unreachable
        ? 'TTS 봇에 연결하지 못했어요. TTS 봇이 실행 중인지 확인해 주세요.'
        : `TTS 봇 처리에 실패했어요 — ${result.reason}`,
    })
  }

  /** 서버 전체 멤버를 검색해 고르는 유저 선택(방장 이전/추방/차단용). */
  private async openUserSelect(
    interaction: MessageComponentInteraction,
    action: string,
    placeholder: string
  ): Promise<void> {
    if (!interaction.isButton()) return
    await interaction.reply(buildUserSelectMessage(action, placeholder))
  }

  private async doTransfer(
    interaction: MessageComponentInteraction,
    channel: VoiceChannel,
    room: TempVoiceRoom
  ): Promise<void> {
    if (!interaction.isUserSelectMenu()) return
    const target = interaction.values[0]
    if (target === undefined) return

    if (target === room.ownerId) {
      await interaction.update({ content: '이미 방장이에요.', components: [] })
      return
    }
    const member = channel.members.get(target)
    if (member === undefined) {
      await interaction.update({
        content:
          '그 사람은 지금 통화방에 없어요. 통화방에 있는 사람에게만 넘길 수 있어요.',
        components: [],
      })
      return
    }
    if (member.user.bot) {
      await interaction.update({
        content: '봇에게는 방장을 넘길 수 없어요.',
        components: [],
      })
      return
    }

    const prevOwner = room.ownerId
    await this.applyOwnership(channel, target)
    await interaction.update({
      content: `<@${target}>님에게 방장을 넘겼어요.`,
      components: [],
    })
    await channel
      .send(`👑 <@${target}>님이 새 방장이 되었어요.`)
      .catch(() => undefined)
    void this.logTempVoice(channel.guild.id, {
      emoji: '👑',
      title: '방장 이전',
      color: 0x3498db,
      lines: [
        `통화방: **${channel.name}**`,
        `이전: <@${prevOwner}> → <@${target}>`,
        `처리: <@${interaction.user.id}> (수동)`,
      ],
    })
  }

  /** 내보내기 1단계: 대상을 정했으면 사유 선택으로 넘어간다. */
  private async doKickShowReason(
    interaction: MessageComponentInteraction,
    channel: VoiceChannel,
    room: TempVoiceRoom
  ): Promise<void> {
    if (!interaction.isUserSelectMenu()) return
    const target = interaction.values[0]
    if (target === undefined) return

    const err = this.validateKickTarget(target, channel, room)
    if (err !== null) {
      await interaction.update({ content: err, components: [] })
      return
    }
    await interaction.update(buildKickReasonMessage(target))
  }

  /** 내보내기 2단계: 사유 선택. 프리셋이면 바로 실행, '기타'면 입력 모달. */
  private async doKickReason(
    interaction: MessageComponentInteraction,
    channel: VoiceChannel,
    room: TempVoiceRoom,
    targetId: string
  ): Promise<void> {
    if (!interaction.isStringSelectMenu()) return
    const key = interaction.values[0]
    if (key === undefined) return

    if (key === 'custom') {
      await interaction.showModal(buildKickReasonModal(targetId))
      return
    }
    const reason = kickReasonLabel(key)
    if (reason === null) return

    const result = await this.performKick(
      channel,
      room,
      targetId,
      reason,
      interaction.user.id
    )
    await interaction.update({ content: result, components: [] })
  }

  /** 내보내기 대상 유효성 검사. 문제 있으면 사용자용 메시지, 없으면 null. */
  private validateKickTarget(
    target: string,
    channel: VoiceChannel,
    room: TempVoiceRoom
  ): string | null {
    if (target === room.ownerId) return '방장은 자기 자신을 내보낼 수 없어요.'
    const member = channel.members.get(target)
    if (member === undefined) return '그 사람은 지금 통화방에 없어요.'
    if (member.user.bot) return '봇은 내보낼 수 없어요.'
    return null
  }

  /** 실제 내보내기: 사유 DM(임베드) 발송 후 연결 끊기. 결과 메시지를 반환. */
  private async performKick(
    channel: VoiceChannel,
    room: TempVoiceRoom,
    targetId: string,
    reason: string,
    actorId: string
  ): Promise<string> {
    if (targetId === room.ownerId) return '방장은 내보낼 수 없어요.'
    const member = channel.members.get(targetId)
    if (member === undefined) return '그 사람은 이미 통화방에 없어요.'

    // 먼저 사유를 DM으로 알리고(가능하면), 그다음 내보낸다.
    const dmOk = await this.sendKickDm(member, channel, reason)
    const kicked = await member.voice
      .disconnect(`내보내기: ${reason}`)
      .then(() => true)
      .catch(() => false)

    if (!kicked) {
      return `<@${targetId}>님을 내보내지 못했어요. 봇 역할이 이 유저보다 낮거나 서버 소유자일 수 있어요.`
    }
    void this.logTempVoice(channel.guild.id, {
      emoji: '🚪',
      title: '내보내기',
      color: 0xe74c3c,
      lines: [
        `통화방: **${channel.name}**`,
        `대상: <@${targetId}>`,
        `처리: <@${actorId}>`,
        `사유: ${reason}`,
        dmOk ? null : '-# DM 전달 실패(상대가 DM 차단)',
      ],
    })
    return `<@${targetId}>님을 내보냈어요.\n사유: ${reason}${
      dmOk ? '' : '\n-# DM은 전달하지 못했어요 (상대가 DM을 막아둔 상태).'
    }`
  }

  private async sendKickDm(
    member: GuildMember,
    channel: VoiceChannel,
    reason: string
  ): Promise<boolean> {
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('통화방에서 내보내졌어요')
      .setDescription(
        `**${channel.guild.name}** 서버의 통화방 **${channel.name}**에서 내보내졌어요.`
      )
      .addFields({ name: '사유', value: reason })
      .setTimestamp()
    return member.user
      .send({ embeds: [embed] })
      .then(() => true)
      .catch(() => false)
  }

  // ─── 헬퍼 ───

  private canControl(
    interaction: MessageComponentInteraction | ModalSubmitInteraction,
    room: TempVoiceRoom
  ): boolean {
    // 통화방에 실제로 들어와 있어야 조작 가능 — 방장이든 관리자든 원격 조작은 막는다.
    if (!this.isInRoom(room, interaction.user.id)) return false

    if (interaction.user.id === room.ownerId) return true
    const perms = interaction.memberPermissions
    if (perms === null) return false
    return (
      perms.has(PermissionFlagsBits.ManageGuild) ||
      perms.has(PermissionFlagsBits.ManageChannels)
    )
  }

  /** userId가 지금 그 통화방(음성 채널)에 접속해 있는지. */
  private isInRoom(room: TempVoiceRoom, userId: string): boolean {
    const channel = this.getVoiceChannel(room.guildId, room.channelId)
    return channel !== null && channel.members.has(userId)
  }

  private getVoiceChannel(
    guildId: string,
    channelId: string
  ): VoiceChannel | null {
    const guild = this.client.guilds.cache.get(guildId)
    if (guild === undefined) return null
    const channel = guild.channels.cache.get(channelId)
    if (channel === undefined || channel.type !== ChannelType.GuildVoice) {
      return null
    }
    return channel
  }

  private humanMembers(channel: VoiceBasedChannel): string[] {
    return [...channel.members.values()]
      .filter((m) => !m.user.bot)
      .map((m) => m.id)
  }
}

function renderRoomName(
  template: string,
  userName: string,
  count: number
): string {
  const rendered = template
    .replace(/\{user\}/g, userName)
    .replace(/\{count\}/g, String(count))
    .trim()
  const name = rendered.length > 0 ? rendered : `${userName}의 통화방`
  return name.slice(0, 100)
}

function clampNumber(
  raw: string,
  min: number,
  max: number,
  fallback: number
): number {
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function memberCanManage(
  interaction: MessageComponentInteraction | ModalSubmitInteraction
): boolean {
  const perms = interaction.memberPermissions
  if (perms === null) return false
  return (
    perms.has(PermissionFlagsBits.Administrator) ||
    perms.has(PermissionFlagsBits.ManageGuild)
  )
}

export const setup = () => {
  return new TempVoiceExtensionClass()
}
