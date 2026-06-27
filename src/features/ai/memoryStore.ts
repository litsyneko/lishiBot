import { logger } from '../../utils/logger'
import { getSupabase } from './supabase'

export type Memory = {
  id: string
  userId: string
  content: string
  createdAt: string
}

const MAX_MEMORIES = 15
const MAX_CONTENT_LENGTH = 200

export type MemoryStore = {
  list(userId: string): Promise<Memory[]>
  add(userId: string, content: string): Promise<Memory>
  remove(userId: string, memoryId: string): Promise<boolean>
  clear(userId: string): Promise<void>
  formatForPrompt(userId: string): Promise<string>
  buildPersonalityPrompt(userId: string): Promise<string>
  isAvailable(): boolean
}

export function createMemoryStore(): MemoryStore {
  const isAvailable = () => getSupabase() !== null

  async function list(userId: string): Promise<Memory[]> {
    const supabase = getSupabase()
    if (supabase === null) return []

    const { data, error } = await supabase
      .from('user_memories')
      .select('id, user_id, content, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(MAX_MEMORIES)

    if (error !== null) {
      logger.warn('Memory', `메모리 조회 실패: ${error.message}`)
      return []
    }

    return (data ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      content: r.content,
      createdAt: r.created_at,
    }))
  }

  async function add(userId: string, content: string): Promise<Memory> {
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase not configured')

    const trimmed = content.trim().slice(0, MAX_CONTENT_LENGTH)

    const existing = await list(userId)
    if (existing.length >= MAX_MEMORIES) {
      const oldest = existing.reduce((a, b) =>
        a.createdAt < b.createdAt ? a : b
      )
      await supabase.from('user_memories').delete().eq('id', oldest.id)
    }

    const { data, error } = await supabase
      .from('user_memories')
      .insert({ user_id: userId, content: trimmed })
      .select('id, user_id, content, created_at')
      .single()

    if (error !== null)
      throw new Error(`Failed to save memory: ${error.message}`)
    return {
      id: data.id,
      userId: data.user_id,
      content: data.content,
      createdAt: data.created_at,
    }
  }

  async function remove(userId: string, memoryId: string): Promise<boolean> {
    const supabase = getSupabase()
    if (supabase === null) return false

    const { error } = await supabase
      .from('user_memories')
      .delete()
      .eq('id', memoryId)
      .eq('user_id', userId)

    return error === null
  }

  async function clear(userId: string): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    await supabase.from('user_memories').delete().eq('user_id', userId)
  }

  async function formatForPrompt(userId: string): Promise<string> {
    const memories = await list(userId)
    if (memories.length === 0) return ''

    const lines = memories.map((m) => `- ${m.content}`)
    return `[사용자 메모]\n${lines.join('\n')}\n\n`
  }

  function buildPersonalityAdjustments(memories: Memory[]): string {
    const adjustments: string[] = []

    for (const memory of memories) {
      const content = memory.content.toLowerCase()

      if (
        content.includes('이모티콘 싫어') ||
        content.includes('이모지 싫어') ||
        content.includes('이모티콘 별로')
      ) {
        adjustments.push(
          '- 사용자가 이모지를 싫어하므로 이모지를 사용하지 마세요.'
        )
      }
      if (
        content.includes('간결') ||
        content.includes('짧게') ||
        content.includes('간단히')
      ) {
        adjustments.push(
          '- 사용자가 간결한 답변을 선호하므로 1~2문장으로 짧게 답변하세요.'
        )
      }
      if (
        content.includes('자세') ||
        content.includes('길게') ||
        content.includes('상세')
      ) {
        adjustments.push(
          '- 사용자가 자세한 설명을 선호하므로 충분한 정보를 제공하세요.'
        )
      }
      if (
        content.includes('진지') ||
        content.includes('차분') ||
        content.includes('진중')
      ) {
        adjustments.push(
          '- 사용자가 진지한 태도를 선호하므로 차분하고 진지하게 대화하세요.'
        )
      }
      if (
        content.includes('장난') ||
        content.includes('유머') ||
        content.includes('농담')
      ) {
        adjustments.push(
          '- 사용자가 유머를 좋아하므로 가벼운 농담을 섞어 대화하세요.'
        )
      }
      if (
        content.includes('조용') ||
        content.includes('말 많이') ||
        content.includes('시끄럽')
      ) {
        adjustments.push(
          '- 사용자가 조용한 대화를 선호하므로 최소한의 말로 답변하세요.'
        )
      }
    }

    if (adjustments.length === 0) return ''

    const unique = [...new Set(adjustments)]
    return `[사용자 성향 조정]\n${unique.join('\n')}\n\n`
  }

  async function buildPersonalityPrompt(userId: string): Promise<string> {
    const memories = await list(userId)
    return buildPersonalityAdjustments(memories)
  }

  return {
    list,
    add,
    remove,
    clear,
    formatForPrompt,
    buildPersonalityPrompt,
    isAvailable,
  }
}

let globalStore: MemoryStore | null = null

export function getMemoryStore(): MemoryStore {
  if (globalStore === null) {
    globalStore = createMemoryStore()
  }
  return globalStore
}
