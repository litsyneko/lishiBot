import { config } from '../config'
import { createResilientFetch } from '../features/ai/resilientFetch'
import { TTS_VOICES, voiceLabel } from '../tts/ttsVoices'
import { logger } from '../utils/logger'
import { replyEphemeral, replyPublic } from '../utils/replies'
import { Extension, SubCommandGroup, listener } from '@pikokr/command.ts'
import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  type Client,
  GuildMember,
  type Interaction,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js'

const DEFAULT_PORT = 8787

// /tts 목소리 셀렉트 메뉴 인터랙션 식별용 customId.
const VOICE_SELECT_ID = 'tts:voice:select'

const ttsGroup = new SubCommandGroup({
  name: 'tts',
  description: '읽어주기(TTS) 봇을 음성채널로 불러 채팅을 읽게 합니다.',
})

function controlUrl(): string | null {
  const cfg = config.tts
  if (cfg === undefined || cfg.token.trim().length === 0) return null
  if (cfg.controlUrl !== undefined && cfg.controlUrl.length > 0) {
    return cfg.controlUrl.replace(/\/+$/u, '')
  }
  return `http://127.0.0.1:${cfg.port ?? DEFAULT_PORT}`
}

// 제어 요청용 fetch. 입장은 음성 Ready 대기(최대 15초)를 포함하므로
// 타임아웃을 그보다 넉넉히 준다. 타임아웃 없이는 TTS 봇이 hang일 때
// 슬래시 명령까지 같이 멈춘다.
const controlFetch = createResilientFetch({
  label: 'TTS 제어',
  maxAttempts: 1,
  requestTimeoutMs: 20_000,
})

const healthFetch = createResilientFetch({
  label: 'TTS 헬스체크',
  maxAttempts: 1,
  requestTimeoutMs: 3_000,
})

type ControlResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: string
      readonly unreachable: boolean
    }

async function postControl(
  path: string,
  body: Record<string, string>
): Promise<ControlResult> {
  const base = controlUrl()
  if (base === null) {
    return {
      ok: false,
      reason: 'TTS 봇이 설정되지 않았어요.',
      unreachable: true,
    }
  }

  try {
    const res = await controlFetch(`${base}${path}`, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    if (res.ok) return { ok: true }

    // TTS 봇이 던진 구체적 실패 사유(권한 없음, 채널 없음 등)를 꺼내 전달.
    const errBody = (await res.json().catch(() => null)) as {
      error?: string
    } | null
    return {
      ok: false,
      reason: errBody?.error ?? `TTS 봇 오류 (HTTP ${res.status})`,
      unreachable: false,
    }
  } catch (err) {
    logger.error(
      'TTS',
      `제어 요청 실패(${path}): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return {
      ok: false,
      reason: 'TTS 봇에 연결하지 못했어요.',
      unreachable: true,
    }
  }
}

export type TtsControlResult = ControlResult

/**
 * TTS 봇을 지정한 음성 채널로 불러 해당 텍스트 채널의 채팅을 읽게 한다.
 * `/tts 입장`과 동일한 제어 경로 — 임시 통화방 패널 등에서 재사용한다.
 */
export async function summonTtsBot(
  guildId: string,
  textChannelId: string,
  voiceChannelId: string
): Promise<TtsControlResult> {
  return postControl('/join', { guildId, textChannelId, voiceChannelId })
}

/** TTS 봇을 현재 음성 채널에서 내보낸다(`/tts 퇴장`과 동일 경로). */
export async function dismissTtsBot(
  guildId: string
): Promise<TtsControlResult> {
  return postControl('/leave', { guildId })
}

// ── TTS 봇 생존 감시 ──────────────────────────────────────────────
// 세션이 tts-bot 프로세스 RAM에만 있어서 봇이 죽거나 재시작하면 읽어주기가
// 조용히 멈춘다. /health(부팅시각+활성세션)를 폴링해 재시작/무응답을
// 감지하고, 읽고 있던 텍스트 채널에 안내를 남긴다.

const HEALTH_POLL_MS = 20_000
// 연속 실패 횟수가 이 값에 도달하면(≈40초) 무응답으로 판정.
const HEALTH_DOWN_THRESHOLD = 2

type TtsSessionInfo = {
  readonly guildId: string
  readonly textChannelId: string
  readonly voiceChannelId: string
}

type TtsHealth = {
  // 0 = 아직 헬스체크 전(입장 미러만 반영된 상태)이라 재시작 판정에서 제외.
  startedAt: number
  sessions: TtsSessionInfo[]
}

let lastHealth: TtsHealth | null = null
let healthFailures = 0
let notifiedDown = false

// 입장/퇴장 성공 직후, 다음 폴링 전에도 세션을 알 수 있게 미러링.
function recordLocalSession(session: TtsSessionInfo): void {
  if (lastHealth === null) {
    lastHealth = { sessions: [], startedAt: 0 }
  }
  lastHealth.sessions = lastHealth.sessions
    .filter((s) => s.guildId !== session.guildId)
    .concat(session)
}

function forgetLocalSession(guildId: string): void {
  if (lastHealth === null) return
  lastHealth.sessions = lastHealth.sessions.filter((s) => s.guildId !== guildId)
}

async function notifySessionChannels(
  client: Client,
  sessions: readonly TtsSessionInfo[],
  content: string
): Promise<void> {
  for (const session of sessions) {
    try {
      const channel = await client.channels.fetch(session.textChannelId)
      if (channel !== null && channel.isSendable()) {
        await channel.send(content)
      }
    } catch (err) {
      logger.warn(
        'TTS',
        `상태 안내 실패 (channel ${session.textChannelId}): ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
}

async function pollTtsHealth(client: Client): Promise<void> {
  const base = controlUrl()
  if (base === null) return

  try {
    const res = await healthFetch(`${base}/health`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const raw = (await res.json()) as {
      sessions?: TtsSessionInfo[]
      startedAt?: number
    }
    const snapshot: TtsHealth = {
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    }

    const prev = lastHealth
    const wasDown = notifiedDown
    healthFailures = 0
    notifiedDown = false
    lastHealth = snapshot

    if (prev === null) return

    const restarted =
      prev.startedAt !== 0 && prev.startedAt !== snapshot.startedAt
    if (restarted) {
      logger.warn(
        'TTS',
        `TTS 봇 재시작 감지 (이전 세션 ${prev.sessions.length}개 소멸)`
      )
      if (prev.sessions.length > 0) {
        await notifySessionChannels(
          client,
          prev.sessions,
          '🔄 TTS 봇이 재시작되어 음성채널에서 나갔어요. 계속 들으시려면 `/tts 입장`으로 다시 불러주세요.'
        )
      }
      return
    }

    if (wasDown) {
      // 같은 프로세스가 그대로 응답을 재개함(일시 무응답) — 세션 유지.
      logger.info('TTS', 'TTS 봇 응답 복구 (세션 유지)')
      if (prev.sessions.length > 0) {
        await notifySessionChannels(
          client,
          prev.sessions,
          '✅ TTS 봇이 복구됐어요. 읽어주기는 그대로 이어져요.'
        )
      }
    }
  } catch (err) {
    healthFailures++
    if (healthFailures !== HEALTH_DOWN_THRESHOLD) return

    logger.warn(
      'TTS',
      `TTS 봇 무응답 감지 (연속 ${healthFailures}회): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    if (
      !notifiedDown &&
      lastHealth !== null &&
      lastHealth.sessions.length > 0
    ) {
      notifiedDown = true
      await notifySessionChannels(
        client,
        lastHealth.sessions,
        '🔇 TTS 봇이 응답하지 않아 읽어주기가 중단된 것 같아요. 복구되면 다시 안내드릴게요.'
      )
    } else {
      notifiedDown = true
    }
  }
}

class TtsExtensionClass extends Extension {
  @ttsGroup.command({
    name: '입장',
    description:
      '내가 있는 음성채널에 TTS 봇을 불러 이 채널의 채팅을 읽게 합니다.',
  })
  async join(i: ChatInputCommandInteraction) {
    const guild = i.guild
    if (guild === null) {
      await replyEphemeral(i, '서버에서만 사용할 수 있어요.')
      return
    }

    if (controlUrl() === null) {
      await replyEphemeral(i, 'TTS 봇이 설정되지 않았어요. (config.tts)')
      return
    }

    const member =
      i.member instanceof GuildMember
        ? i.member
        : await guild.members.fetch(i.user.id).catch(() => null)
    const voiceChannel = member?.voice.channel ?? null
    if (voiceChannel === null) {
      await replyEphemeral(i, '먼저 음성채널에 들어가 주세요.')
      return
    }

    const result = await postControl('/join', {
      guildId: guild.id,
      textChannelId: i.channelId,
      voiceChannelId: voiceChannel.id,
    })

    if (!result.ok) {
      await replyEphemeral(
        i,
        result.unreachable
          ? 'TTS 봇에 연결하지 못했어요. TTS 봇이 실행 중인지 확인해 주세요.'
          : `TTS 봇이 입장하지 못했어요 — ${result.reason}`
      )
      return
    }

    recordLocalSession({
      guildId: guild.id,
      textChannelId: i.channelId,
      voiceChannelId: voiceChannel.id,
    })

    await replyPublic(
      i,
      `🔊 <#${voiceChannel.id}> 에 입장했어요. 이제 <#${i.channelId}> 채널의 메시지를 읽어드려요.`
    )
  }

  @ttsGroup.command({
    name: '목소리',
    description: '내 메시지를 읽을 TTS 목소리를 선택합니다.',
  })
  async voice(i: ChatInputCommandInteraction) {
    if (controlUrl() === null) {
      await replyEphemeral(i, 'TTS 봇이 설정되지 않았어요. (config.tts)')
      return
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId(VOICE_SELECT_ID)
      .setPlaceholder('목소리를 선택하세요')
      .addOptions(
        TTS_VOICES.map((v) => ({
          description: v.description,
          label: v.label,
          value: v.id,
        }))
      )

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      menu
    )

    await i.reply({
      components: [row],
      content: '🎙️ 내 메시지를 읽어줄 목소리를 골라주세요.',
      flags: MessageFlags.Ephemeral,
    })
  }

  // 셀렉트 메뉴에서 목소리를 고르면 TTS 봇에 반영한다.
  @listener({ event: 'interactionCreate' })
  async onVoiceSelect(interaction: Interaction): Promise<void> {
    if (!interaction.isStringSelectMenu()) return
    if (interaction.customId !== VOICE_SELECT_ID) return

    const voiceId = interaction.values[0]
    if (voiceId === undefined) return

    const result = await postControl('/voice', {
      userId: interaction.user.id,
      voiceId,
    })

    if (!result.ok) {
      await interaction.update({
        components: [],
        content: result.unreachable
          ? 'TTS 봇에 연결하지 못했어요. TTS 봇이 실행 중인지 확인해 주세요.'
          : `목소리를 바꾸지 못했어요 — ${result.reason}`,
      })
      return
    }

    await interaction.update({
      components: [],
      content: `🎙️ 이제 내 메시지는 **${voiceLabel(
        voiceId
      )}** 목소리로 읽어드려요!`,
    })
  }

  @ttsGroup.command({
    name: '퇴장',
    description: 'TTS 봇을 음성채널에서 내보냅니다.',
  })
  async leave(i: ChatInputCommandInteraction) {
    const guild = i.guild
    if (guild === null) {
      await replyEphemeral(i, '서버에서만 사용할 수 있어요.')
      return
    }

    if (controlUrl() === null) {
      await replyEphemeral(i, 'TTS 봇이 설정되지 않았어요. (config.tts)')
      return
    }

    const result = await postControl('/leave', { guildId: guild.id })
    if (!result.ok) {
      await replyEphemeral(
        i,
        result.unreachable
          ? 'TTS 봇에 연결하지 못했어요.'
          : `TTS 봇을 내보내지 못했어요 — ${result.reason}`
      )
      return
    }

    forgetLocalSession(guild.id)

    await replyPublic(i, '👋 TTS 봇이 음성채널에서 나갔어요.')
  }

  private healthWatcherStarted = false

  // TTS 봇 생존 감시 시작 (봇 로그인 후 1회).
  @listener({ event: 'clientReady' })
  async startHealthWatcher() {
    if (this.healthWatcherStarted) return
    if (controlUrl() === null) return
    this.healthWatcherStarted = true

    setInterval(() => {
      void pollTtsHealth(this.client)
    }, HEALTH_POLL_MS).unref?.()
    logger.info(
      'TTS',
      `TTS 봇 상태 감시 시작 (${HEALTH_POLL_MS / 1000}초 간격)`
    )
  }
}

export const setup = async () => {
  return new TtsExtensionClass()
}
