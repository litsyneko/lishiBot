import { logger } from '../../utils/logger'
import { getSupabase } from '../ai/supabase'

const ROOMS_TABLE = 'temp_voice_rooms'
const ROOMS_COLUMNS =
  'channel_id, guild_id, owner_id, created_by, locked, blocked_ids, created_at'

export type TempVoiceRoom = {
  readonly channelId: string
  readonly guildId: string
  ownerId: string
  readonly createdBy: string
  locked: boolean
  blockedIds: string[]
  readonly createdAt: number
}

// channelId -> 방 레코드 (권위 있는 in-memory 상태, DB와 동기화)
const rooms = new Map<string, TempVoiceRoom>()
// guildId:userId -> 마지막 생성 시각(ms). 연속 생성 방지 쿨다운.
const lastCreatedAt = new Map<string, number>()

function cooldownKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`
}

export async function loadTempVoiceRooms(): Promise<void> {
  const supabase = getSupabase()
  if (supabase === null) return

  const { data, error } = await supabase.from(ROOMS_TABLE).select(ROOMS_COLUMNS)
  if (error !== null) {
    logger.error('TempVoice', `통화방 로드 실패: ${error.message}`)
    return
  }
  if (data === null) return

  for (const row of data) {
    const room = parseRoomRow(row)
    if (room !== null) rooms.set(room.channelId, room)
  }
  logger.info('TempVoice', `${rooms.size}개 활성 통화방 로드 완료`)
}

export function getRoom(channelId: string): TempVoiceRoom | undefined {
  return rooms.get(channelId)
}

export function isTempRoom(channelId: string): boolean {
  return rooms.has(channelId)
}

export function getRoomByOwner(
  guildId: string,
  ownerId: string
): TempVoiceRoom | undefined {
  for (const room of rooms.values()) {
    if (room.guildId === guildId && room.ownerId === ownerId) return room
  }
  return undefined
}

export function listGuildRooms(guildId: string): TempVoiceRoom[] {
  return [...rooms.values()].filter((room) => room.guildId === guildId)
}

export function listAllRooms(): TempVoiceRoom[] {
  return [...rooms.values()]
}

export async function createRoomRecord(input: {
  channelId: string
  guildId: string
  ownerId: string
  createdBy: string
  createdAt: number
}): Promise<TempVoiceRoom> {
  const room: TempVoiceRoom = {
    channelId: input.channelId,
    guildId: input.guildId,
    ownerId: input.ownerId,
    createdBy: input.createdBy,
    locked: false,
    blockedIds: [],
    createdAt: input.createdAt,
  }
  rooms.set(room.channelId, room)

  const supabase = getSupabase()
  if (supabase !== null) {
    const { error } = await supabase.from(ROOMS_TABLE).upsert(
      {
        channel_id: room.channelId,
        guild_id: room.guildId,
        owner_id: room.ownerId,
        created_by: room.createdBy,
        locked: room.locked,
        blocked_ids: room.blockedIds,
        created_at: new Date(room.createdAt).toISOString(),
      },
      { onConflict: 'channel_id' }
    )
    if (error !== null) {
      logger.error('TempVoice', `통화방 저장 실패: ${error.message}`)
    }
  }

  return room
}

/** 방 레코드를 부분 갱신하고 DB에 반영한다. 존재하지 않으면 null. */
export async function updateRoomRecord(
  channelId: string,
  patch: { ownerId?: string; locked?: boolean; blockedIds?: string[] }
): Promise<TempVoiceRoom | null> {
  const room = rooms.get(channelId)
  if (room === undefined) return null

  if (patch.ownerId !== undefined) room.ownerId = patch.ownerId
  if (patch.locked !== undefined) room.locked = patch.locked
  if (patch.blockedIds !== undefined) room.blockedIds = patch.blockedIds

  const supabase = getSupabase()
  if (supabase !== null) {
    const { error } = await supabase
      .from(ROOMS_TABLE)
      .update({
        owner_id: room.ownerId,
        locked: room.locked,
        blocked_ids: room.blockedIds,
      })
      .eq('channel_id', channelId)
    if (error !== null) {
      logger.error('TempVoice', `통화방 갱신 실패: ${error.message}`)
    }
  }

  return room
}

export async function deleteRoomRecord(channelId: string): Promise<void> {
  rooms.delete(channelId)

  const supabase = getSupabase()
  if (supabase !== null) {
    const { error } = await supabase
      .from(ROOMS_TABLE)
      .delete()
      .eq('channel_id', channelId)
    if (error !== null) {
      logger.error('TempVoice', `통화방 삭제 실패: ${error.message}`)
    }
  }
}

// ─── 쿨다운(연속 생성 방지) ───

/** 쿨다운이 남아있으면 남은 초를 반환, 아니면 0. */
export function remainingCooldownSeconds(
  guildId: string,
  userId: string,
  cooldownSeconds: number,
  now: number
): number {
  if (cooldownSeconds <= 0) return 0
  const last = lastCreatedAt.get(cooldownKey(guildId, userId))
  if (last === undefined) return 0
  const elapsed = now - last
  const remainMs = cooldownSeconds * 1000 - elapsed
  return remainMs > 0 ? Math.ceil(remainMs / 1000) : 0
}

export function markCreated(
  guildId: string,
  userId: string,
  now: number
): void {
  lastCreatedAt.set(cooldownKey(guildId, userId), now)
}

// ─── 방장 위임 대상 선정 ───

/**
 * 방장 위임 후보를 고른다. 방에 남아있는 비봇 멤버 중 방에 가장 오래 있던 사람.
 * joinTimes에 정보가 없으면 members 순서의 첫 번째로 폴백한다.
 */
export function pickNextOwner(
  memberIds: readonly string[],
  excludeId: string,
  joinTimes: ReadonlyMap<string, number>
): string | null {
  const candidates = memberIds.filter((id) => id !== excludeId)
  if (candidates.length === 0) return null

  let best: string | null = null
  let bestTime = Number.POSITIVE_INFINITY
  for (const id of candidates) {
    const t = joinTimes.get(id) ?? Number.POSITIVE_INFINITY
    if (t < bestTime) {
      bestTime = t
      best = id
    }
  }
  // 전원 시각 정보가 없으면(재시작 등) 첫 후보로 폴백.
  return best ?? candidates[0] ?? null
}

function parseRoomRow(row: {
  readonly channel_id?: string | null
  readonly guild_id?: string | null
  readonly owner_id?: string | null
  readonly created_by?: string | null
  readonly locked?: boolean | null
  readonly blocked_ids?: unknown
  readonly created_at?: string | null
}): TempVoiceRoom | null {
  if (
    typeof row.channel_id !== 'string' ||
    typeof row.guild_id !== 'string' ||
    typeof row.owner_id !== 'string'
  ) {
    return null
  }
  const createdAt =
    typeof row.created_at === 'string' ? Date.parse(row.created_at) : Number.NaN
  return {
    channelId: row.channel_id,
    guildId: row.guild_id,
    ownerId: row.owner_id,
    createdBy:
      typeof row.created_by === 'string' ? row.created_by : row.owner_id,
    locked: row.locked === true,
    blockedIds: parseIdList(row.blocked_ids),
    createdAt: Number.isNaN(createdAt) ? Date.now() : createdAt,
  }
}

function parseIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0
  )
}
