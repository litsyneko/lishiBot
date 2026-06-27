import { getMemoryStore } from '../../memoryStore'
import type { ToolDefinition } from '../toolTypes'

export const saveMemoryTool: ToolDefinition = {
  declaration: {
    name: 'save_memory',
    description:
      '사용자가 공유한 개인 정보, 취향, 성격, 일정 등 기억할 가치가 있는 내용을 저장합니다. 200자 이내로 요약해서 저장하세요.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            '기억할 내용. 200자 이내. 구체적인 문장보다 "사용자는 수박을 좋아함" 같은 간결한 사실 위주로.',
        },
      },
      required: ['content'],
    },
  },
  permission: {
    requireManageGuild: false,
    requireAdmin: false,
    risk: 'info',
  },
  execute: async (args, context) => {
    const content = args.content as string | undefined
    if (!content || content.trim().length === 0) {
      return { success: false, message: '저장할 내용이 없어요.' }
    }
    if (content.length > 200) {
      return { success: false, message: '200자 이내로만 저장할 수 있어요.' }
    }

    const store = getMemoryStore()
    if (!store.isAvailable()) {
      return {
        success: false,
        message: '메모리를 사용할 수 없어요 (Supabase 미설정).',
      }
    }

    try {
      await store.add(context.userId, content)
      return { success: true, message: '기억을 저장했어요!' }
    } catch (err) {
      return {
        success: false,
        message: `메모리 저장 실패: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }
    }
  },
}
