import type { ChatMessage } from './aiPolicy'
import type { ToolRecord } from './aiPolicy'

const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const MAX_HISTORY_PER_SESSION = 20
const MAX_TOOL_HISTORY = 100
const ORPHAN_SESSION_TTL_MS = 6 * 60 * 60 * 1000

export type Session = {
  history: ChatMessage[]
  toolHistory: ToolRecord[]
  lastActivity: number
  messageIds: Set<string>
}

const sessions = new Map<string, Session>()
const messageIdToSession = new Map<string, string>()

function isExpired(session: Session, now: number = Date.now()): boolean {
  return now - session.lastActivity > SESSION_TTL_MS
}

function isOrphaned(session: Session, now: number = Date.now()): boolean {
  return (
    session.messageIds.size === 0 &&
    now - session.lastActivity > ORPHAN_SESSION_TTL_MS
  )
}

function deleteSession(sessionKey: string): void {
  const session = sessions.get(sessionKey)
  if (session === undefined) {
    return
  }
  for (const messageId of session.messageIds) {
    const mapped = messageIdToSession.get(messageId)
    if (mapped === sessionKey) {
      messageIdToSession.delete(messageId)
    }
  }
  sessions.delete(sessionKey)
}

function bindMessage(
  sessionKey: string,
  session: Session,
  messageId: string
): void {
  session.messageIds.add(messageId)
  messageIdToSession.set(messageId, sessionKey)
}

function getOrCreateSession(guildId: string, userId: string): string {
  const sessionKey = `${guildId}:${userId}`
  const existing = sessions.get(sessionKey)
  if (existing !== undefined) {
    if (isOrphaned(existing)) {
      deleteSession(sessionKey)
    } else if (isExpired(existing) && existing.messageIds.size === 0) {
      deleteSession(sessionKey)
    } else {
      existing.lastActivity = Date.now()
      return sessionKey
    }
  }
  sessions.set(sessionKey, {
    history: [],
    toolHistory: [],
    lastActivity: Date.now(),
    messageIds: new Set<string>(),
  })
  return sessionKey
}

function getSessionByMessage(
  messageId: string
): { sessionKey: string; session: Session } | undefined {
  const sessionKey = messageIdToSession.get(messageId)
  if (sessionKey === undefined) {
    return undefined
  }
  const session = sessions.get(sessionKey)
  if (session === undefined) {
    messageIdToSession.delete(messageId)
    return undefined
  }
  return { sessionKey, session }
}

function reviveSession(sessionKey: string): void {
  const session = sessions.get(sessionKey)
  if (session === undefined) {
    return
  }
  session.lastActivity = Date.now()
}

function appendToSession(
  sessionKey: string,
  message: ChatMessage,
  botMessageId?: string
): void {
  const session = sessions.get(sessionKey)
  if (session === undefined) {
    return
  }
  const trimmed = [...session.history, message].slice(-MAX_HISTORY_PER_SESSION)
  session.history = trimmed
  session.lastActivity = Date.now()
  if (botMessageId !== undefined) {
    bindMessage(sessionKey, session, botMessageId)
  }
}

function getHistory(sessionKey: string): readonly ChatMessage[] {
  const session = sessions.get(sessionKey)
  if (session === undefined) {
    return []
  }
  if (isExpired(session) && session.messageIds.size === 0) {
    deleteSession(sessionKey)
    return []
  }
  return session.history
}

function appendToToolHistory(
  sessionKey: string,
  records: readonly ToolRecord[]
): void {
  const session = sessions.get(sessionKey)
  if (session === undefined) {
    return
  }
  const trimmed = [...session.toolHistory, ...records].slice(-MAX_TOOL_HISTORY)
  session.toolHistory = trimmed
}

function getToolHistory(sessionKey: string): readonly ToolRecord[] {
  const session = sessions.get(sessionKey)
  if (session === undefined) {
    return []
  }
  return session.toolHistory
}

function bindMessageToSession(sessionKey: string, messageId: string): void {
  const session = sessions.get(sessionKey)
  if (session === undefined) {
    return
  }
  bindMessage(sessionKey, session, messageId)
}

function pruneExpiredSessions(): void {
  const now = Date.now()
  for (const sessionKey of Array.from(sessions.keys())) {
    const session = sessions.get(sessionKey)
    if (session !== undefined && isOrphaned(session, now)) {
      deleteSession(sessionKey)
    }
  }
}

setInterval(pruneExpiredSessions, 10 * 60 * 1000).unref?.()

export {
  SESSION_TTL_MS,
  MAX_HISTORY_PER_SESSION,
  getOrCreateSession,
  getSessionByMessage,
  reviveSession,
  appendToSession,
  getHistory,
  appendToToolHistory,
  getToolHistory,
  bindMessageToSession,
  pruneExpiredSessions,
}
