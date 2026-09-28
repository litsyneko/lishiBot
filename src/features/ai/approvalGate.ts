import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from './tools/toolTypes'
import { randomUUID } from 'node:crypto'

// 위험(risk: 'danger') 도구 호출을 에이전트 루프 안에서 가로채 보류한 제안.
// 실행은 승인 카드의 [실행 승인] 버튼을 통해서만 이뤄진다.
// 안전 기본값: 서버 프로필(approval_policy) 유무와 무관하게 danger 도구는 무조건 승인 필요.
export type ApprovalProposal = {
  readonly id: string
  readonly toolName: string
  readonly args: Record<string, unknown>
  readonly context: ToolExecutionContext
  readonly requesterId: string
  readonly createdAt: number
}

export type ProposalCollector = {
  // 실행 대신 제안을 기록하고, 모델에는 승인 대기 상태만 반환한다.
  readonly propose: (
    toolDef: ToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ) => ToolResult
  // 수집된 제안을 꺼내고 비운다. generate 종료 후 승인 카드 전송 시 호출.
  readonly drain: () => ApprovalProposal[]
  readonly hasPending: () => boolean
}

// generate 1회 단위로 만들어 execute 래퍼에 물린다.
// 같은 (도구, 인자) 재호출은 중복 제안 없이 같은 상태만 반환한다.
export function createProposalCollector(): ProposalCollector {
  const drafts = new Map<string, ApprovalProposal>()

  return {
    propose(toolDef, args, context) {
      const toolName = toolDef.declaration.name
      const dedupeKey = `${toolName}:${JSON.stringify(args)}`
      if (!drafts.has(dedupeKey)) {
        drafts.set(dedupeKey, {
          id: randomUUID(),
          toolName,
          args,
          context,
          requesterId: context.userId,
          createdAt: Date.now(),
        })
      }
      return {
        success: true,
        message: 'approval_required',
        data: { status: 'approval_required' },
      }
    },
    hasPending() {
      return drafts.size > 0
    },
    drain() {
      const list = [...drafts.values()]
      drafts.clear()
      return list
    },
  }
}
