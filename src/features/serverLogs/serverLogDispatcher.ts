import { logger } from '../../utils/logger'
import { ContainerBuilder, TextDisplayBuilder } from '@discordjs/builders'
import { MessageFlags, type NewsChannel, type TextChannel } from 'discord.js'

export type SendableLogChannel = TextChannel | NewsChannel

type QueuedLog = {
  readonly container: ContainerBuilder
  readonly chars: number
  readonly components: number
}

type ChannelQueue = {
  channel: SendableLogChannel
  pending: QueuedLog[]
  timer: NodeJS.Timeout | null
  flushing: boolean
  dropped: number
}

// 짧은 시간에 몰리는 로그를 한 메시지로 묶어 채널당 전송량(5msg/5s)을 줄인다.
const FLUSH_DELAY_MS = 1500
const MAX_PENDING = 40
const MAX_BATCH_CONTAINERS = 3
// ComponentsV2는 메시지 전체 텍스트 4000자, 컴포넌트 40개 제한이 있다.
const MAX_BATCH_CHARS = 3200
const MAX_BATCH_COMPONENTS = 30

const queues = new Map<string, ChannelQueue>()

export function enqueueServerLog(
  channel: SendableLogChannel,
  container: ContainerBuilder
): void {
  const queue = getQueue(channel)
  const json = container.toJSON()

  if (queue.pending.length >= MAX_PENDING) {
    queue.pending.shift()
    queue.dropped += 1
  }

  queue.pending.push({
    chars: countChars(json),
    components: countComponents(json),
    container,
  })
  scheduleFlush(queue)
}

function getQueue(channel: SendableLogChannel): ChannelQueue {
  const existing = queues.get(channel.id)
  if (existing !== undefined) {
    existing.channel = channel
    return existing
  }

  const created: ChannelQueue = {
    channel,
    dropped: 0,
    flushing: false,
    pending: [],
    timer: null,
  }
  queues.set(channel.id, created)
  return created
}

function scheduleFlush(queue: ChannelQueue): void {
  if (queue.timer !== null || queue.flushing) return
  queue.timer = setTimeout(() => {
    queue.timer = null
    void flushQueue(queue)
  }, FLUSH_DELAY_MS)
}

async function flushQueue(queue: ChannelQueue): Promise<void> {
  if (queue.flushing) return
  queue.flushing = true

  try {
    while (queue.pending.length > 0) {
      const batch = takeBatch(queue)

      try {
        await queue.channel.send({
          allowedMentions: { parse: [] },
          components: batch.map((item) => item.container),
          flags: MessageFlags.IsComponentsV2,
        })
      } catch (err) {
        // 전송에 실패한 배치는 버려 무한 재시도를 막되, 생략 안내에 집계한다.
        queue.dropped += batch.length
        logger.error(
          'ServerLog',
          `로그 전송 실패 (#${queue.channel.name}): ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }

    if (queue.dropped > 0) {
      const dropped = queue.dropped
      queue.dropped = 0
      try {
        await queue.channel.send({
          allowedMentions: { parse: [] },
          components: [buildDroppedNotice(dropped)],
          flags: MessageFlags.IsComponentsV2,
        })
      } catch {
        // 안내 실패는 무시
      }
    }
  } finally {
    queue.flushing = false
    if (queue.pending.length > 0) scheduleFlush(queue)
  }
}

function takeBatch(queue: ChannelQueue): QueuedLog[] {
  const batch: QueuedLog[] = []
  let chars = 0
  let components = 0

  while (queue.pending.length > 0 && batch.length < MAX_BATCH_CONTAINERS) {
    const next = queue.pending[0]
    const wouldOverflow =
      batch.length > 0 &&
      (chars + next.chars > MAX_BATCH_CHARS ||
        components + next.components > MAX_BATCH_COMPONENTS)
    if (wouldOverflow) break

    queue.pending.shift()
    batch.push(next)
    chars += next.chars
    components += next.components
  }

  return batch
}

function buildDroppedNotice(dropped: number): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ⚠️ 이벤트가 짧은 시간에 몰려 로그 ${dropped}개를 생략했어요.`
      )
    )
}

function countChars(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((sum, item) => sum + countChars(item), 0)
  }
  if (typeof node === 'object' && node !== null) {
    let sum = 0
    for (const [key, value] of Object.entries(node)) {
      if (key === 'content' && typeof value === 'string') {
        sum += value.length
      } else {
        sum += countChars(value)
      }
    }
    return sum
  }
  return 0
}

function countComponents(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((sum, item) => sum + countComponents(item), 0)
  }
  if (typeof node === 'object' && node !== null) {
    const record = node as Record<string, unknown>
    let sum = typeof record['type'] === 'number' ? 1 : 0
    for (const value of Object.values(record)) {
      sum += countComponents(value)
    }
    return sum
  }
  return 0
}
