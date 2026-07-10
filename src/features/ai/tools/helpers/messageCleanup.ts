import type { GuildTextBasedChannel, Message } from 'discord.js'

// 메시지 대량 삭제 공통 로직. AI 도구(bulk_delete_messages)와 슬래시(/서버 청소)가 공유한다.

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000

/** 채널 최근 count개 메시지를 100개씩 페이지네이션으로 수집한다. */
export async function fetchRecentMessages(
  channel: GuildTextBasedChannel,
  count: number
): Promise<Message[]> {
  const collected: Message[] = []
  let before: string | undefined
  while (collected.length < count) {
    const limit = Math.min(100, count - collected.length)
    const batch = await channel.messages.fetch(
      before === undefined ? { limit } : { limit, before }
    )
    if (batch.size === 0) break
    const arr = [...batch.values()]
    collected.push(...arr)
    before = arr[arr.length - 1]?.id
    if (batch.size < limit) break
  }
  return collected
}

export type BulkDeleteResult = {
  readonly deleted: number
  readonly failed: number
  readonly oldCount: number
}

/**
 * 주어진 메시지들을 삭제한다.
 * - 14일 이내: bulkDelete로 100개씩 한 번에(filterOld로 경계에서 빠진 건 개별 폴백).
 * - 14일 초과: 디스코드가 벌크를 막으므로 개별 순차(상한 없음). discord.js가 rate limit을 자동 관리.
 */
export async function deleteMessagesBulk(
  channel: GuildTextBasedChannel,
  messages: readonly Message[]
): Promise<BulkDeleteResult> {
  const now = Date.now()
  const recent = messages.filter((m) => now - m.createdTimestamp < TWO_WEEKS_MS)
  const old = messages.filter((m) => now - m.createdTimestamp >= TWO_WEEKS_MS)

  let deleted = 0
  let failed = 0

  for (let i = 0; i < recent.length; i += 100) {
    const chunk = recent.slice(i, i + 100)
    try {
      if (chunk.length === 1) {
        const single = chunk[0]
        if (single !== undefined) {
          await single.delete()
          deleted += 1
        }
      } else {
        const removed = await channel.bulkDelete(chunk, true)
        deleted += removed.size
        for (const m of chunk) {
          if (!removed.has(m.id)) {
            try {
              await m.delete()
              deleted += 1
            } catch {
              failed += 1
            }
          }
        }
      }
    } catch {
      failed += chunk.length
    }
  }

  for (const m of old) {
    try {
      await m.delete()
      deleted += 1
    } catch {
      failed += 1
    }
  }

  return { deleted, failed, oldCount: old.length }
}
