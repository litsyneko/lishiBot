import type { Guild, Invite } from 'discord.js'

export type InviteAttribution = {
  readonly code: string
  readonly inviterId: string | null
  readonly inviterTag: string | null
  readonly isVanity: boolean
}

type InviteSnapshot = {
  readonly uses: number
  readonly maxUses: number
  readonly inviterId: string | null
  readonly inviterTag: string | null
}

type DeletedInvite = {
  readonly snapshot: InviteSnapshot
  readonly code: string
  readonly deletedAt: number
}

const RECENTLY_DELETED_TTL_MS = 30_000
const PRIME_FAILURE_TTL_MS = 10 * 60_000

const guildInvites = new Map<string, Map<string, InviteSnapshot>>()
const guildVanityUses = new Map<string, number>()
const recentlyDeleted = new Map<string, DeletedInvite[]>()
const primeFailedAt = new Map<string, number>()
const resolveChains = new Map<string, Promise<InviteAttribution | null>>()

function snapshotOf(invite: Invite): InviteSnapshot {
  return {
    inviterId: invite.inviterId,
    inviterTag: invite.inviter?.tag ?? null,
    maxUses: invite.maxUses ?? 0,
    uses: invite.uses ?? 0,
  }
}

/** 초대 목록을 캐시한다. 초대 관리 권한이 없으면 추적을 포기한다. */
export async function primeGuildInvites(guild: Guild): Promise<void> {
  try {
    const invites = await guild.invites.fetch()
    const usage = new Map<string, InviteSnapshot>()
    for (const invite of invites.values()) {
      usage.set(invite.code, snapshotOf(invite))
    }
    guildInvites.set(guild.id, usage)
    primeFailedAt.delete(guild.id)
  } catch {
    guildInvites.delete(guild.id)
    primeFailedAt.set(guild.id, Date.now())
  }

  if (guild.vanityURLCode !== null) {
    try {
      const vanity = await guild.fetchVanityData()
      guildVanityUses.set(guild.id, vanity.uses ?? 0)
    } catch {
      guildVanityUses.delete(guild.id)
    }
  }
}

export function trackInviteCreate(invite: Invite): void {
  const guildId = invite.guild?.id
  if (guildId === undefined) return
  const usage = guildInvites.get(guildId)
  if (usage === undefined) return
  usage.set(invite.code, snapshotOf(invite))
}

export function trackInviteDelete(invite: Invite): void {
  const guildId = invite.guild?.id
  if (guildId === undefined) return
  const usage = guildInvites.get(guildId)
  if (usage === undefined) return

  // 일회용 초대는 사용되는 순간 삭제 이벤트가 먼저 올 수 있어,
  // 잠시 보관해 두고 참가 귀속에 사용한다.
  const snapshot = usage.get(invite.code)
  if (snapshot !== undefined) {
    const list = recentlyDeleted.get(guildId) ?? []
    list.push({ code: invite.code, deletedAt: Date.now(), snapshot })
    recentlyDeleted.set(guildId, list)
  }
  usage.delete(invite.code)
}

/**
 * 멤버 참가 직후 초대 사용량을 비교해 어떤 초대로 들어왔는지 추정한다.
 * 동시 입장 시 스냅샷이 교차 오염되지 않도록 길드별로 순차 실행한다.
 * 확정할 수 없으면 null을 반환한다.
 */
export function resolveJoinInvite(
  guild: Guild
): Promise<InviteAttribution | null> {
  const prior = resolveChains.get(guild.id) ?? Promise.resolve(null)
  const task = prior.then(() => doResolveJoinInvite(guild))
  resolveChains.set(guild.id, task)
  void task.finally(() => {
    if (resolveChains.get(guild.id) === task) {
      resolveChains.delete(guild.id)
    }
  })
  return task
}

async function doResolveJoinInvite(
  guild: Guild
): Promise<InviteAttribution | null> {
  const previous = guildInvites.get(guild.id)
  if (previous === undefined) {
    // 권한 부족 등으로 최근 프라이밍에 실패했다면 참가마다 재시도하지 않는다.
    const failedAt = primeFailedAt.get(guild.id)
    if (
      failedAt !== undefined &&
      Date.now() - failedAt < PRIME_FAILURE_TTL_MS
    ) {
      return null
    }
    await primeGuildInvites(guild)
    return null
  }

  try {
    const invites = await guild.invites.fetch()
    const next = new Map<string, InviteSnapshot>()
    let used: InviteAttribution | null = null

    for (const invite of invites.values()) {
      const snapshot = snapshotOf(invite)
      next.set(invite.code, snapshot)

      if (used !== null) continue
      const before = previous.get(invite.code)
      const increased =
        before !== undefined ? snapshot.uses > before.uses : snapshot.uses > 0
      if (increased) {
        used = {
          code: invite.code,
          inviterId: snapshot.inviterId,
          inviterTag: snapshot.inviterTag,
          isVanity: false,
        }
      }
    }
    guildInvites.set(guild.id, next)

    if (used !== null) return used

    const consumed = takeRecentlyConsumedInvite(guild.id)
    if (consumed !== null) return consumed

    return await resolveVanityJoin(guild)
  } catch {
    return null
  }
}

/** 최대 사용 횟수 도달로 삭제된(=방금 소진된) 초대를 귀속 후보로 사용한다. */
function takeRecentlyConsumedInvite(guildId: string): InviteAttribution | null {
  const list = recentlyDeleted.get(guildId)
  if (list === undefined || list.length === 0) return null

  const now = Date.now()
  const fresh = list.filter(
    (item) => now - item.deletedAt <= RECENTLY_DELETED_TTL_MS
  )

  const candidate = fresh
    .filter((item) => item.snapshot.maxUses > 0)
    .sort((a, b) => b.deletedAt - a.deletedAt)[0]

  if (candidate === undefined) {
    recentlyDeleted.set(guildId, fresh)
    return null
  }

  recentlyDeleted.set(
    guildId,
    fresh.filter((item) => item !== candidate)
  )
  return {
    code: candidate.code,
    inviterId: candidate.snapshot.inviterId,
    inviterTag: candidate.snapshot.inviterTag,
    isVanity: false,
  }
}

async function resolveVanityJoin(
  guild: Guild
): Promise<InviteAttribution | null> {
  if (guild.vanityURLCode === null) return null

  try {
    const vanity = await guild.fetchVanityData()
    const uses = vanity.uses ?? 0
    const previousUses = guildVanityUses.get(guild.id)
    guildVanityUses.set(guild.id, uses)
    if (previousUses !== undefined && uses > previousUses) {
      return {
        code: guild.vanityURLCode,
        inviterId: null,
        inviterTag: null,
        isVanity: true,
      }
    }
    return null
  } catch {
    return null
  }
}
