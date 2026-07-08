import { logger } from '../../utils/logger'
import type { ChatMessage } from './aiPolicy'
import type { ToolRecord } from './aiPolicy'
import { getSupabase } from './supabase'

const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const MAX_HISTORY_PER_SESSION = 20
const MAX_TOOL_HISTORY = 100
const MAX_TOOL_HISTORY_PROMPT_RECORDS = 8
const MAX_TOOL_HISTORY_FIELD_LENGTH = 240
const ORPHAN_SESSION_TTL_MS = 6 * 60 * 60 * 1000

const SESSIONS_TABLE = 'ai_sessions'
const MESSAGES_TABLE = 'ai_session_messages'
const KST_TZ = 'Asia/Seoul'
// 부팅 시 프리로드할 세션 범위 (idle TTL 안쪽 세션만 캐시로 복원)
const PRELOAD_WINDOW_MS = SESSION_TTL_MS

export type Session = {
  history: ChatMessage[]
  toolHistory: ToolRecord[]
  startedAt: number // daily 롤오버 기준 (KST 날짜 비교)
  lastActivity: number // idle 만료 기준
  messageIds: Set<string>
  guildId: string
  channelId: string
  userId: string
}

const sessions = new Map<string, Session>()
const messageIdToSession = new Map<string, string>()

// 세션별 persist 직렬화 체인.
// 세션 upsert → 메시지 insert 순서를 보장해 FK(ai_session_messages → ai_sessions) 위반을 막는다.
const persistChains = new Map<string, Promise<void>>()

function enqueue(sessionKey: string, task: () => Promise<void>): void {
  const prev = persistChains.get(sessionKey) ?? Promise.resolve()
  // 체인 유지가 목적이라 개별 실패는 여기서 흡수한다(각 task가 자체 로깅).
  const next = prev.then(task).catch(() => undefined)
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
    const { error } = await supabase.from(MESSAGES_TABLE).insert({
      session_key: sessionKey,
      role: message.role,
      content: message.content,
      discord_message_id: discordMessageId ?? null,
    })
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

// KST(Asia/Seoul) 기준 날짜 문자열(YYYY-MM-DD). daily 롤오버 판정용.
function kstDateString(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: KST_TZ })
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
    const rolledOver = kstDateString(existing.startedAt) !== kstDateString(now)
    if (isOrphaned(existing, now)) {
      deleteSession(sessionKey)
    } else if (isExpired(existing, now) && existing.messageIds.size === 0) {
      deleteSession(sessionKey)
    } else if (rolledOver) {
      // KST 날짜가 넘어가면 이어지는 스레드가 있어도 새 세션으로 롤오버한다.
      // 자정을 넘기면 새 대화로 보는 게 자연스럽다(직전 요약 물림은 이후 summary 단계에서 보완).
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

// 답장으로 이어가려는 추적 세션을 롤오버 규율에 맞춰 되살린다.
// 같은 KST 날짜면 revive 후 sessionKey를 반환한다.
// 자정(KST)을 넘겼으면 세션을 폐기하고 undefined를 반환한다
// → 호출자가 getOrCreateSession으로 새 대화를 시작한다(getOrCreateSession 롤오버 경로와 동일 규율).
function continueSession(referencedMessageId: string): string | undefined {
  const traced = getSessionByMessage(referencedMessageId)
  if (traced === undefined) {
    return undefined
  }
  const rolledOver =
    kstDateString(traced.session.startedAt) !== kstDateString(Date.now())
  if (rolledOver) {
    deleteSession(traced.sessionKey)
    return undefined
  }
  reviveSession(traced.sessionKey)
  return traced.sessionKey
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
  enqueue(sessionKey, () => persistMessage(sessionKey, message, botMessageId))
  enqueue(sessionKey, () => touchSessionMeta(session, sessionKey))
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
    if (session !== undefined && isOrphaned(session, now)) {
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

    for (const row of rows) {
      const sessionKey: string = row.session_key
      const { data: msgs } = await supabase
        .from(MESSAGES_TABLE)
        .select('role, content, discord_message_id, created_at')
        .eq('session_key', sessionKey)
        .order('created_at', { ascending: true })

      const rows2 = msgs ?? []
      const history: ChatMessage[] = rows2
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          content: m.content as string,
          role: m.role as 'user' | 'assistant',
        }))
        .slice(-MAX_HISTORY_PER_SESSION)

      const messageIds = new Set<string>()
      for (const m of rows2) {
        if (typeof m.discord_message_id === 'string' && m.discord_message_id) {
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
      })
    }
    logger.info('AiSession', `${rows.length}개 AI 세션 로드 완료`)
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

function clearSessionsForChannel(guildId: string, channelId: string): number {
  let count = 0
  const prefix = `${guildId}:${channelId}:`
  for (const sessionKey of Array.from(sessions.keys())) {
    if (sessionKey.startsWith(prefix)) {
      deleteSession(sessionKey)
      count++
    }
  }
  return count
}

export {
  SESSION_TTL_MS,
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
  clearSessionsForChannel,
}
