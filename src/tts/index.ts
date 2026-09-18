import { config } from '../config'
import { logger } from '../utils/logger'
import { startControlServer } from './controlServer'
import {
  isElevenLabsConfigured,
  isTtsDisabled,
  setExpirationHandler,
  synthesizeSpeech,
} from './elevenLabs'
import { mixSpeechWithBackground } from './ttsMix'
import {
  clearSession,
  getSession,
  listSessions,
  setSession,
} from './ttsSessions'
import { extractSfx, getSfxAudio, getSfxMode } from './ttsSfx'
import {
  buildPresenceAnnouncement,
  buildStickerReadout,
  isCensoredText,
  prepareTtsText,
} from './ttsText'
import {
  enqueueAudio,
  getVoiceChannelId,
  isConnected,
  joinGuildVoice,
  leaveGuildVoice,
  scheduleLeaveWhenDrained,
  setForcedDisconnectHandler,
} from './ttsVoice'
import { getUserVoiceId, loadUserVoices, setUserVoice } from './ttsVoiceStore'
import { isKnownVoiceId, voiceLabel } from './ttsVoices'
import {
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  type Message,
  PermissionFlagsBits,
  type VoiceState,
} from 'discord.js'
import sodium from 'libsodium-wrappers'

const DEFAULT_PORT = 8787

// 프로세스 부팅 시각. /health에 실어 보내 메인봇이 재시작을 감지한다.
const BOOT_TIME = Date.now()

const ttsConfig = config.tts

// 19금·쌍욕(high 등급) 메시지 대신 읽는 검열 멘트. 매번 같은 문구라 오디오를 캐시한다.
const CENSOR_LINE = '[mischievously] 삐— 삐— 삐— 그런 건 못 읽어요!'
let censorAudioCache: Buffer | null = null

// API 만료 시 음성채널에서 읽어줄 안내 멘트. 만료 후엔 합성이 불가능하므로
// 키가 살아있는 부팅 시점에 미리 합성해 저장해 둔다(선 저장 → 만료 시 재생).
const EXPIRY_NOTICE_LINE =
  'api 만료가 되어 TTS 기능을 비활성화 되었습니다. 이 문제는 관리자에게 문의를 해주세요!'
let expiryNoticeCache: Buffer | null = null

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

client.on('clientReady', () => {
  logger.info('TTS', `TTS 봇 로그인 완료: ${client.user?.tag}`)
  if (!isElevenLabsConfigured()) {
    logger.warn('TTS', 'ElevenLabs 미설정 - 음성 합성이 비활성화됩니다.')
  }
  void loadUserVoices()
  void primeExpiryNotice()
})

// 만료 안내 음성을 부팅 시(키 유효할 때) 미리 합성해 캐시. 겸사겸사
// 키 상태 헬스체크 역할도 한다.
async function primeExpiryNotice(): Promise<void> {
  if (!isElevenLabsConfigured()) return
  const audio = await synthesizeSpeech(EXPIRY_NOTICE_LINE)
  if (audio !== null) {
    expiryNoticeCache = audio
    logger.info('TTS', '만료 안내 음성 사전 합성 완료')
  } else {
    logger.warn(
      'TTS',
      '만료 안내 음성 사전 합성 실패 — 만료 시 음성 안내 없이 embed만 전송됩니다.'
    )
  }
}

client.on('messageCreate', async (message: Message) => {
  try {
    if (message.author.bot) return
    if (message.guild === null) return

    const session = getSession(message.guild.id)
    if (session === undefined) return
    if (message.channel.id !== session.textChannelId) return

    // 스티커 이름 읽을거리 (스티커만 있는 메시지는 content가 비어 있음)
    const stickerReadout = buildStickerReadout(
      message.stickers.map((sticker) => sticker.name)
    )

    // 19금·쌍욕(high 등급 욕설)은 읽지 않고 검열 멘트로 대체 (본문 + 스티커 이름 검사)
    if (isCensoredText(`${message.content} ${stickerReadout ?? ''}`)) {
      if (censorAudioCache === null) {
        censorAudioCache = await synthesizeSpeech(CENSOR_LINE)
      }
      if (censorAudioCache !== null) {
        enqueueAudio(message.guild.id, censorAudioCache)
      }
      return
    }

    // 멘션 ID → 표시 이름(닉네임 우선). 탈퇴 등으로 못 찾으면 undefined.
    const resolveMention = (id: string): string | undefined => {
      const member = message.mentions.members?.get(id)
      if (member != null) return member.displayName
      const user = message.mentions.users.get(id)
      return user?.displayName ?? user?.username
    }

    const bodyText = prepareTtsText(message.content, { resolveMention })

    // 본문과 스티커 이름을 합쳐 읽는다. 스티커만 있는 메시지도 이름을 읽어준다.
    const text = [bodyText, stickerReadout]
      .filter((part): part is string => part !== null && part.length > 0)
      .join('. ')
    if (text.length === 0) return

    // 효과음 태그([빗소리] 등)는 v3가 못 만들므로 분리해서 배경으로 깐다.
    const { effect, cleaned } = extractSfx(text)

    // 효과음만 있는 메시지 → 효과음 단독 재생
    if (effect !== null && cleaned.length === 0) {
      const sfx = await getSfxAudio(effect)
      if (sfx !== null) enqueueAudio(message.guild.id, sfx)
      return
    }

    // 사용자가 선택한 목소리로 합성 (미설정 시 기본 음성)
    const speech = await synthesizeSpeech(
      effect !== null ? cleaned : text,
      getUserVoiceId(message.author.id)
    )
    if (speech === null) return

    if (effect !== null) {
      const sfx = await getSfxAudio(effect)
      if (sfx !== null) {
        const mixed = await mixSpeechWithBackground(
          speech,
          sfx,
          getSfxMode(effect) === 'ambient'
        )
        enqueueAudio(message.guild.id, mixed ?? speech)
        return
      }
    }

    enqueueAudio(message.guild.id, speech)
  } catch (err) {
    logger.warn(
      'TTS',
      `메시지 처리 오류: ${err instanceof Error ? err.message : String(err)}`
    )
  }
})

// 통화방 입장/퇴장 안내 + 아무도 남지 않으면 자동 퇴장.
client.on(
  'voiceStateUpdate',
  async (oldState: VoiceState, newState: VoiceState) => {
    try {
      const guild = newState.guild
      if (!isConnected(guild.id)) return

      const voiceChannelId = getVoiceChannelId(guild.id)
      if (voiceChannelId === undefined) return

      const channel = guild.channels.cache.get(voiceChannelId)
      if (channel === undefined || channel.type !== ChannelType.GuildVoice) {
        return
      }

      // 사람이 아무도 없으면 안내 없이 자동 퇴장 (들을 사람이 없음)
      const humans = channel.members.filter((m) => !m.user.bot)
      if (humans.size === 0) {
        logger.info('TTS', `음성채널이 비어 자동 퇴장 (guild ${guild.id})`)
        leaveGuildVoice(guild.id)
        clearSession(guild.id)
        return
      }

      // 입장/퇴장 안내 (TTS 봇 자신은 제외)
      const member = newState.member ?? oldState.member
      if (member === null || member.id === client.user?.id) return

      const joined =
        newState.channelId === voiceChannelId &&
        oldState.channelId !== voiceChannelId
      const left =
        oldState.channelId === voiceChannelId &&
        newState.channelId !== voiceChannelId
      if (!joined && !left) return

      const line = buildPresenceAnnouncement(
        member.displayName,
        member.user.bot,
        joined
      )
      const audio = await synthesizeSpeech(line, getUserVoiceId(member.id))
      if (audio !== null) enqueueAudio(guild.id, audio)
    } catch (err) {
      logger.warn(
        'TTS',
        `입퇴장 안내 오류: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
)

// 텍스트 채널에 embed 알림을 보낸다. 실패는 조용히 로그만.
async function sendTtsEmbed(
  textChannelId: string,
  opts: { color: number; title: string; description: string }
): Promise<void> {
  try {
    const channel = await client.channels.fetch(textChannelId)
    if (channel !== null && channel.isSendable()) {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(opts.color)
            .setTitle(opts.title)
            .setDescription(opts.description),
        ],
      })
    }
  } catch (err) {
    logger.warn(
      'TTS',
      `embed 알림 전송 실패: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

// 음성 연결이 강제로 끊겼을 때(관리자의 연결 끊기 등) 세션을 정리하고
// 읽던 텍스트 채널에 안내를 남긴다. 조용한 좀비 세션 방지.
setForcedDisconnectHandler((guildId) => {
  void (async () => {
    const session = getSession(guildId)
    clearSession(guildId)
    if (session === undefined) return

    logger.warn('TTS', `음성 연결 강제 종료 감지 (guild ${guildId})`)
    await sendTtsEmbed(session.textChannelId, {
      color: 0x99aab5,
      title: '🔇 TTS 종료',
      description:
        '음성채널 연결이 끊겨서 TTS를 종료했어요.\n계속 들으시려면 `/tts 입장`으로 다시 불러주세요.',
    })
  })()
})

// ElevenLabs API 만료 감지 시: 안내 embed → 저장된(합성 완료) 음성 재생 완료
// → 음성채널 퇴장 → "TTS 종료" embed. 활성 세션 전부에 적용.
setExpirationHandler(() => {
  const sessions = listSessions()
  logger.error(
    'TTS',
    `ElevenLabs 만료 — ${sessions.length}개 세션 종료 절차 시작`
  )
  for (const session of sessions) {
    void (async () => {
      // 1) 비활성화 안내 embed
      await sendTtsEmbed(session.textChannelId, {
        color: 0xe5372f,
        title: '⚠️ TTS 기능 비활성화',
        description:
          'api 만료가 되어 TTS기능을 비활성화 되었습니다.\n이 문제는 관리자에게 문의를 해주세요!',
      })
      // 2) 부팅 때 미리 저장해 둔 안내 음성을 큐 끝에 넣어 재생.
      //    (만료 후엔 합성 불가라 이 사전 저장본이 유일한 음성 안내다.)
      if (expiryNoticeCache !== null) {
        enqueueAudio(session.guildId, expiryNoticeCache)
      }
      // 3) 저장된 음성(안내 포함) 재생 완료 후 → 퇴장 + 종료 embed
      scheduleLeaveWhenDrained(session.guildId, () => {
        leaveGuildVoice(session.guildId)
        clearSession(session.guildId)
        void sendTtsEmbed(session.textChannelId, {
          color: 0x99aab5,
          title: '🔇 TTS 종료',
          description:
            '저장된 음성 재생을 마치고 음성채널에서 나갔어요.\n문제가 해결되면 `/tts 입장`으로 다시 불러주세요.',
        })
      })
    })()
  }
})

startControlServer(ttsConfig?.port ?? DEFAULT_PORT, {
  onJoin: async ({ guildId, voiceChannelId, textChannelId }) => {
    // 입장 전 사전 검사 — 실패 사유를 구체적으로 던지면 controlServer가
    // {error} JSON으로 반환하고, 메인봇이 사용자에게 그대로 안내한다.
    // 만료로 비활성화된 상태면 입장해도 읽을 수 없으니 미리 막는다.
    if (isTtsDisabled()) {
      throw new Error(
        'TTS 기능이 api 만료로 비활성화됐어요. 관리자에게 문의해 주세요.'
      )
    }

    const guild = await client.guilds.fetch(guildId).catch(() => null)
    if (guild === null) {
      throw new Error('TTS 봇이 이 서버에 초대되어 있지 않아요.')
    }

    const channel =
      guild.channels.cache.get(voiceChannelId) ??
      (await guild.channels.fetch(voiceChannelId).catch(() => null))
    if (channel === null || channel === undefined || !channel.isVoiceBased()) {
      throw new Error('음성채널을 찾을 수 없어요.')
    }

    const me =
      guild.members.me ?? (await guild.members.fetchMe().catch(() => null))
    if (me === null) {
      throw new Error('TTS 봇 멤버 정보를 가져오지 못했어요.')
    }

    const perms = channel.permissionsFor(me)
    if (
      !perms.has(PermissionFlagsBits.ViewChannel) ||
      !perms.has(PermissionFlagsBits.Connect)
    ) {
      throw new Error(
        'TTS 봇에게 이 음성채널에 들어갈 권한이 없어요. (채널 보기·연결 권한을 확인해 주세요)'
      )
    }
    if (!perms.has(PermissionFlagsBits.Speak)) {
      throw new Error(
        'TTS 봇에게 말하기 권한이 없어요. (말하기 권한을 확인해 주세요)'
      )
    }
    if (
      channel.userLimit > 0 &&
      channel.members.size >= channel.userLimit &&
      !perms.has(PermissionFlagsBits.MoveMembers)
    ) {
      throw new Error('음성채널 인원이 가득 차서 들어갈 수 없어요.')
    }

    await joinGuildVoice(guild, voiceChannelId)
    setSession(guildId, { textChannelId, voiceChannelId })
    logger.info(
      'TTS',
      `입장: guild ${guildId}, VC ${voiceChannelId}, 읽을채널 ${textChannelId}`
    )
  },
  onLeave: async ({ guildId }) => {
    leaveGuildVoice(guildId)
    clearSession(guildId)
    logger.info('TTS', `퇴장: guild ${guildId}`)
  },
  onSetVoice: async ({ userId, voiceId }) => {
    if (!isKnownVoiceId(voiceId)) {
      throw new Error('unknown voice')
    }
    await setUserVoice(userId, voiceId)
    logger.info('TTS', `목소리 변경: ${userId} → ${voiceLabel(voiceId)}`)
  },
  onHealth: () => ({
    sessions: listSessions(),
    startedAt: BOOT_TIME,
  }),
})

const start = async (): Promise<void> => {
  if (ttsConfig === undefined || ttsConfig.token.trim().length === 0) {
    logger.error('TTS', 'config.tts.token이 없어 TTS 봇을 시작할 수 없어요.')
    process.exit(1)
  }

  await sodium.ready
  await client.login(ttsConfig.token)
}

start().catch((err) => {
  logger.error(
    'TTS',
    `TTS 봇 시작 실패: ${err instanceof Error ? err.message : String(err)}`
  )
  process.exit(1)
})

function shutdown(signal: string): void {
  logger.info('TTS', `${signal} 수신, 종료하는 중...`)
  client.destroy()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
