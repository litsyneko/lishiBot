import { logger } from '../../utils/logger'
import type { ChatMessage } from './aiPolicy'
import type { ToolRecord } from './aiPolicy'
import { getSupabase } from './supabase'

const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000
// 세션당 대화 저장 상한. 프롬프트에 넣을 때는 providerCore가 컨텍스트 예산(토큰)으로
// 한 번 더 자르므로, 이 값은 저장 상한이자 예산이 담을 수 있는 최대치의 안전망이다.
const MAX_HISTORY_PER_SESSION = 200
const MAX_TOOL_HISTORY = 100
const MAX_TOOL_HISTORY_PROMPT_RECORDS = 8
const MAX_TOOL_HISTORY_FIELD_LENGTH = 240
const ORPHAN_SESSION_TTL_MS = SESSION_TTL_MS

const SESSIONS_TABLE = 'ai_sessions'
const MESSAGES_TABLE = 'ai_session_messages'
// 부팅 시 프리로드할 세션 범위 (idle TTL 안쪽 세션만 캐시로 복원)
const PRELOAD_WINDOW_MS = SESSION_TTL_MS
let metadataColumnUnavailable = false

function isMissingMetadataColumn(error: {
  code?: string
  message?: string
}): boolean {
  return (
    (error.code === '42703' || error.code === 'PGRST204') &&
    (error.message?.includes('metadata') ?? false)
  )
}

function restoreImageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => {
      if (typeof item !== 'string') return false
      try {
        const url = new URL(item)
        return (
          url.protocol === 'https:' &&
          (url.hostname === 'cdn.discordapp.com' ||
            url.hostname === 'media.discordapp.net')
        )
      } catch {
        return false
      }
    })
    .slice(0, 4)
}

export type Session = {
  history: ChatMessage[]
  toolHistory: ToolRecord[]
  startedAt: number // 대화 시작 시각
  lastActivity: number // idle 만료 기준
  messageIds: Set<string>
  guildId: string
  channelId: string
  userId: string // 대화를 시작한 사용자
  participantIds: Set<string>
}

const sessions = new Map<string, Session>()
const messageIdToSession = new Map<string, string>()

// 세션별 persist 직렬화 체인.
// 세션 upsert → 메시지 insert 순서를 보장해 FK(ai_session_messages → ai_sessions) 위반을 막는다.
const persistChains = new Map<string, Promise<void>>()

function enqueue(sessionKey: string, task: () => Promise<void>): void {
  const prev = persistChains.get(sessionKey) ?? Promise.resolve()
  // 체인 유지가 목적이라 개별 실패는 여기서 흡수한다(각 task가 자체 로깅).
  const next = prev
    .then(task)
    .catch(() => undefined)
    .finally(() => {
      if (persistChains.get(sessionKey) === next) {
        persistChains.delete(sessionKey)
      }
    })
  persistChains.set(sessionKey, next)
}

// ── DB write-through (fire-and-forget) ──
// 테이블 부재(42P01)나 임의 에러에도 AI는 계속 살아있어야 한다. 실패 시 RAM-only로 조용히 degrade.

// DB 연속 실패 추적. 조용히 degrade하되, DB 자체가 죽은 상황은 한 번은 크게 알린다.
const DB_FAILURE_ALERT_THRESHOLD = 5
let consecutiveDbFailures = 0
let dbFailureAlerted = false

function recordDbSuccess(): void {
  consecutiveDbFailures = 0
  dbFailureAlerted = false
}

function logDbFailure(
  scope: string,
  error: { message?: string; code?: string }
): void {
  // 42P01 = undefined_table. 마이그레이션 미적용 상태이므로 조용히 넘어간다(실패 카운트 제외).
  if (error.code === '42P01') return
  consecutiveDbFailures += 1
  // 임계치 넘으면 한 번만 error로 올리고, 그 뒤엔 다시 조용히. 성공하면 리셋된다.
  if (
    consecutiveDbFailures >= DB_FAILURE_ALERT_THRESHOLD &&
    !dbFailureAlerted
  ) {
    dbFailureAlerted = true
    logger.error(
      'AiSession',
      `DB 쓰기 연속 ${consecutiveDbFailures}회 실패 - 세션 영속화 중단, RAM 전용 degrade: ${
        error.message ?? 'unknown'
      }`
    )
    return
  }
  logger.warn(
    'AiSession',
    `${scope} DB 실패(RAM 유지): ${error.message ?? 'unknown'}`
  )
}

async function persistSessionMeta(
  session: Session,
  sessionKey: string
): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) return
  try {
    const { error } = await supabase.from(SESSIONS_TABLE).upsert(
      {
        session_key: sessionKey,
        guild_id: session.guildId,
        channel_id: session.channelId,
        user_id: session.userId,
        session_started_at: new Date(session.startedAt).toISOString(),
        last_interaction_at: new Date(session.lastActivity).toISOString(),
        tool_history: session.toolHistory,
      },
      { onConflict: 'session_key' }
    )
    if (error !== null) logDbFailure('세션 저장', error)
    else recordDbSuccess()
  } catch (err) {
    logDbFailure('세션 저장', { message: String(err) })
  }
}

// last_interaction_at만 갱신하는 가벼운 update. 매 turn 호출용.
// 세션 row 자체는 생성 시 persistSessionMeta full upsert가 만들어 둔다(persist 체인이 순서 보장).
async function touchSessionMeta(
  session: Session,
  sessionKey: string
): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) return
  try {
    const { error } = await supabase
      .from(SESSIONS_TABLE)
      .update({
        last_interaction_at: new Date(session.lastActivity).toISOString(),
      })
      .eq('session_key', sessionKey)
    if (error !== null) logDbFailure('세션 갱신', error)
    else recordDbSuccess()
  } catch (err) {
    logDbFailure('세션 갱신', { message: String(err) })
  }
}

// tool_history JSON만 update. 도구 실행이 있을 때(appendToToolHistory)만 호출.
// 순서가 중요해 debounce/skip 없이 매 변동마다 올린다.
async function persistToolHistory(
  session: Session,
  sessionKey: string
): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) return
  try {
    const { error } = await supabase
      .from(SESSIONS_TABLE)
      .update({ tool_history: session.toolHistory })
      .eq('session_key', sessionKey)
    if (error !== null) logDbFailure('도구 기록 저장', error)
    else recordDbSuccess()
  } catch (err) {
    logDbFailure('도구 기록 저장', { message: String(err) })
  }
}

async function persistMessage(
  sessionKey: string,
  message: ChatMessage,
  discordMessageId?: string
): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) return
  try {
    const row = {
      session_key: sessionKey,
      role: message.role,
      content: message.content,
      discord_message_id: discordMessageId ?? null,
    }
    const metadata = {
      image_urls: message.imageUrls ?? [],
      author_id: message.authorId ?? null,
      sent_at: message.sentAt ?? null,
      reply_to_message_id: message.replyToMessageId ?? null,
    }
    const insertResult = metadataColumnUnavailable
      ? await supabase.from(MESSAGES_TABLE).insert(row)
      : await supabase.from(MESSAGES_TABLE).insert({ ...row, metadata })
    let { error } = insertResult
    if (error !== null && isMissingMetadataColumn(error)) {
      metadataColumnUnavailable = true
      logger.warn(
        'AiSession',
        '메시지 metadata 컬럼이 없어 기본 기록만 저장합니다. 027 마이그레이션을 적용해 주세요.'
      )
      ;({ error } = await supabase.from(MESSAGES_TABLE).insert(row))
    }
    if (error !== null) logDbFailure('메시지 저장', error)
    else recordDbSuccess()
  } catch (err) {
    logDbFailure('메시지 저장', { message: String(err) })
  }
}

async function deleteSessionFromDb(sessionKey: string): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) return
  try {
    // ai_session_messages는 ON DELETE CASCADE로 함께 삭제된다.
    const { error } = await supabase
      .from(SESSIONS_TABLE)
      .delete()
      .eq('session_key', sessionKey)
    if (error !== null) logDbFailure('세션 삭제', error)
    else recordDbSuccess()
  } catch (err) {
    logDbFailure('세션 삭제', { message: String(err) })
  }
}

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
  enqueue(sessionKey, () => deleteSessionFromDb(sessionKey))
}

function bindMessage(
  sessionKey: string,
  session: Session,
  messageId: string
): void {
  session.messageIds.add(messageId)
  messageIdToSession.set(messageId, sessionKey)
}

function getOrCreateSession(
  guildId: string,
  channelId: string,
  userId: string
): string {
  const sessionKey = `${guildId}:${channelId}:${userId}`
  const now = Date.now()
  const existing = sessions.get(sessionKey)
  if (existing !== undefined) {
    if (isExpired(existing, now) || isOrphaned(existing, now)) {
      deleteSession(sessionKey)
    } else {
      existing.lastActivity = now
      enqueue(sessionKey, () => touchSessionMeta(existing, sessionKey))
      return sessionKey
    }
  }
  const created: Session = {
    history: [],
    toolHistory: [],
    startedAt: now,
    lastActivity: now,
    messageIds: new Set<string>(),
    guildId,
    channelId,
    userId,
    participantIds: new Set([userId]),
  }
  sessions.set(sessionKey, created)
  enqueue(sessionKey, () => persistSessionMeta(created, sessionKey))
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
  enqueue(sessionKey, () => touchSessionMeta(session, sessionKey))
}

// 답장으로 추적한 대화를 3일 활동 기한 안에서 이어간다.
// 다른 사용자의 답장도 같은 세션에 참여시키고, 만료됐으면 이어가지 않는다.
function continueSession(
  referencedMessageId: string,
  guildId: string,
  channelId: string,
  userId: string
): string | undefined {
  const traced = getSessionByMessage(referencedMessageId)
  if (
    traced === undefined ||
    traced.session.guildId !== guildId ||
    traced.session.channelId !== channelId
  ) {
    return undefined
  }
  if (isExpired(traced.session)) {
    deleteSession(traced.sessionKey)
    return undefined
  }
  traced.session.participantIds.add(userId)
  reviveSession(traced.sessionKey)
  return traced.sessionKey
}

function appendToSession(
  sessionKey: string,
  message: ChatMessage,
  discordMessageId?: string
): void {
  const session = sessions.get(sessionKey)
  if (session === undefined) {
    return
  }
  const trimmed = [...session.history, message].slice(-MAX_HISTORY_PER_SESSION)
  session.history = trimmed
  if (message.role === 'user' && message.authorId !== undefined) {
    session.participantIds.add(message.authorId)
  }
  session.lastActivity = Date.now()
  if (message.role === 'assistant' && discordMessageId !== undefined) {
    bindMessage(sessionKey, session, discordMessageId)
  }
  enqueue(sessionKey, () =>
    persistMessage(sessionKey, message, discordMessageId)
  )
  enqueue(sessionKey, () => touchSessionMeta(session, sessionKey))
}

function getHistory(sessionKey: string): readonly ChatMessage[] {
  const session = sessions.get(sessionKey)
  if (session === undefined) {
    return []
  }
  if (isExpired(session)) {
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
  enqueue(sessionKey, () => persistToolHistory(session, sessionKey))
}

function getToolHistory(sessionKey: string): readonly ToolRecord[] {
  const session = sessions.get(sessionKey)
  if (session === undefined) {
    return []
  }
  return session.toolHistory
}

function compactForPrompt(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }

  if (text.length <= MAX_TOOL_HISTORY_FIELD_LENGTH) {
    return text
  }
  return `${text.slice(0, MAX_TOOL_HISTORY_FIELD_LENGTH)}…`
}

function formatToolHistoryForPrompt(sessionKey: string): string {
  const records = getToolHistory(sessionKey).slice(
    -MAX_TOOL_HISTORY_PROMPT_RECORDS
  )
  if (records.length === 0) {
    return ''
  }

  const lines = records.map((record) => {
    const status = record.success ? '성공' : '실패'
    return `- ${record.name} (${status}) args=${compactForPrompt(
      record.args
    )} result=${compactForPrompt(record.result)}`
  })

  return `[최근 도구 실행 기록]\n${lines.join('\n')}\n\n`
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
    if (
      session !== undefined &&
      (isExpired(session, now) || isOrphaned(session, now))
    ) {
      deleteSession(sessionKey)
    }
  }
}

// 부팅 시 Postgres에서 활성 세션을 캐시로 복원한다.
// 테이블이 없거나 Supabase 미설정이면 RAM 전용으로 조용히 동작한다.
async function loadAiSessions(): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) {
    logger.warn('AiSession', 'Supabase 미설정 - AI 세션은 RAM 전용')
    return
  }

  const since = new Date(Date.now() - PRELOAD_WINDOW_MS).toISOString()
  try {
    const { data: rows, error } = await supabase
      .from(SESSIONS_TABLE)
      .select(
        'session_key, guild_id, channel_id, user_id, session_started_at, last_interaction_at, tool_history'
      )
      .gte('last_interaction_at', since)

    if (error !== null) {
      logDbFailure('세션 로드', error)
      return
    }
    if (rows === null) {
      return
    }

    let loadedCount = 0
    for (const row of rows) {
      const sessionKey: string = row.session_key
      const { data: msgs, error: messagesError } = await supabase
        .from(MESSAGES_TABLE)
        .select('*')
        .eq('session_key', sessionKey)
        .order('created_at', { ascending: false })
        .limit(MAX_HISTORY_PER_SESSION)
      if (messagesError !== null) {
        logDbFailure('세션 메시지 로드', messagesError)
        continue
      }

      const rows2 = (msgs ?? []).reverse()
      const history: ChatMessage[] = rows2
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => {
          const metadata =
            typeof m.metadata === 'object' && m.metadata !== null
              ? (m.metadata as Record<string, unknown>)
              : {}
          return {
            content: m.content as string,
            role: m.role as 'user' | 'assistant',
            imageUrls: restoreImageUrls(metadata.image_urls),
            authorId:
              typeof metadata.author_id === 'string'
                ? metadata.author_id
                : undefined,
            sentAt:
              typeof metadata.sent_at === 'string'
                ? metadata.sent_at
                : undefined,
            replyToMessageId:
              typeof metadata.reply_to_message_id === 'string'
                ? metadata.reply_to_message_id
                : undefined,
          }
        })
        .slice(-MAX_HISTORY_PER_SESSION)

      const messageIds = new Set<string>()
      for (const m of rows2) {
        if (
          m.role === 'assistant' &&
          typeof m.discord_message_id === 'string' &&
          m.discord_message_id
        ) {
          messageIds.add(m.discord_message_id)
          messageIdToSession.set(m.discord_message_id, sessionKey)
        }
      }

      sessions.set(sessionKey, {
        history,
        toolHistory: Array.isArray(row.tool_history) ? row.tool_history : [],
        startedAt: new Date(row.session_started_at).getTime(),
        lastActivity: new Date(row.last_interaction_at).getTime(),
        messageIds,
        guildId: row.guild_id,
        channelId: row.channel_id,
        userId: row.user_id,
        participantIds: new Set([
          row.user_id,
          ...history
            .filter((message) => message.role === 'user')
            .map((message) => message.authorId)
            .filter((id): id is string => id !== undefined),
        ]),
      })
      loadedCount += 1
    }
    logger.info('AiSession', `${loadedCount}개 AI 세션 로드 완료`)
  } catch (err) {
    logger.warn('AiSession', `세션 로드 예외(RAM 전용): ${String(err)}`)
  }
}

setInterval(pruneExpiredSessions, 10 * 60 * 1000).unref?.()

function getActiveSessionsCount(guildId: string): number {
  let count = 0
  const now = Date.now()
  for (const session of sessions.values()) {
    if (session.guildId === guildId) {
      // 만료되거나 고아가 아닌 활성 상태인 세션만 카운트
      if (!isOrphaned(session, now) && !isExpired(session, now)) {
        count++
      }
    }
  }
  return count
}

function getUserSessionInfo(
  guildId: string,
  channelId: string,
  userId: string
):
  | { messageCount: number; imageCount: number; lastActivity: number }
  | undefined {
  const sessionKey = `${guildId}:${channelId}:${userId}`
  const session = sessions.get(sessionKey)
  if (session === undefined) return undefined
  if (isExpired(session)) {
    deleteSession(sessionKey)
    return undefined
  }
  return {
    messageCount: session.history.length,
    imageCount: session.history.reduce(
      (count, message) => count + (message.imageUrls?.length ?? 0),
      0
    ),
    lastActivity: session.lastActivity,
  }
}

async function clearUserSession(
  guildId: string,
  channelId: string,
  userId: string
): Promise<boolean> {
  const sessionKey = `${guildId}:${channelId}:${userId}`
  if (!sessions.has(sessionKey)) return false
  deleteSession(sessionKey)
  await persistChains.get(sessionKey)
  return true
}

async function clearSessionsForChannel(
  guildId: string,
  channelId: string
): Promise<number> {
  let count = 0
  const pending: Promise<void>[] = []
  const prefix = `${guildId}:${channelId}:`
  for (const sessionKey of Array.from(sessions.keys())) {
    if (sessionKey.startsWith(prefix)) {
      deleteSession(sessionKey)
      const persistence = persistChains.get(sessionKey)
      if (persistence !== undefined) pending.push(persistence)
      count++
    }
  }
  await Promise.all(pending)
  return count
}

export {
  SESSION_TTL_MS,
  isExpired,
  MAX_HISTORY_PER_SESSION,
  loadAiSessions,
  getOrCreateSession,
  getSessionByMessage,
  continueSession,
  appendToSession,
  getHistory,
  appendToToolHistory,
  getToolHistory,
  formatToolHistoryForPrompt,
  bindMessageToSession,
  pruneExpiredSessions,
  getActiveSessionsCount,
  getUserSessionInfo,
  clearUserSession,
  clearSessionsForChannel,
}
