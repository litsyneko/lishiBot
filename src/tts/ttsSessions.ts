// 길드별 TTS 세션 상태: 어느 음성채널에 있고, 어느 텍스트채널을 읽는지.

export type TtsSession = {
  readonly voiceChannelId: string
  readonly textChannelId: string
}

const sessions = new Map<string, TtsSession>()

export function setSession(guildId: string, session: TtsSession): void {
  sessions.set(guildId, session)
}

export function getSession(guildId: string): TtsSession | undefined {
  return sessions.get(guildId)
}

export function clearSession(guildId: string): void {
  sessions.delete(guildId)
}

export type TtsSessionInfo = TtsSession & { readonly guildId: string }

// 메인봇 헬스체크(/health)에 실어 보내는 활성 세션 목록.
export function listSessions(): TtsSessionInfo[] {
  return [...sessions.entries()].map(([guildId, session]) => ({
    guildId,
    textChannelId: session.textChannelId,
    voiceChannelId: session.voiceChannelId,
  }))
}
