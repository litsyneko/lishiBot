import { logger } from '../../utils/logger'
import type {
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  ProviderAdapter,
} from './aiPolicy'
import {
  ToolExecutionInterruptedError,
  isTurnAborted,
  throwIfTurnAborted,
} from './providerErrors'

const FAILURE_NOTICE =
  '실제 승인 요청을 만들지 못했어요. 작업은 실행되지 않았습니다. 권한을 확인한 뒤 다시 요청해 주세요.'

function hasFabricatedApproval(text: string): boolean {
  return /승인 카드/u.test(text) && /실행 승인|전송|보여/u.test(text)
}

/** 버튼 없는 가짜 승인 문구는 재시도 후에도 실제 도구 호출이 없으면 폐기한다. */
export async function recoverFabricatedApproval(
  provider: ProviderAdapter,
  prompt: string,
  history: readonly ChatMessage[],
  options: GenerateOptions,
  result: GenerateResult,
  approvalPending: () => boolean
): Promise<GenerateResult> {
  throwIfTurnAborted(options.abortSignal)
  if (approvalPending() || !hasFabricatedApproval(result.text)) return result
  const channelRename = /채널.{0,12}(이름|수정|변경)/u.test(result.text)
  const canRetry =
    channelRename && options.tools?.some((tool) => tool.name === 'edit_channel')
  if (result.toolRecords.length > 0 || !canRetry) {
    logger.warn('AI', '실제 승인 제안 없는 승인 카드 문구 차단')
    return { ...result, text: FAILURE_NOTICE }
  }

  try {
    const retried = await provider.generate(prompt, history, {
      ...options,
      toolChoice: { type: 'tool', toolName: 'edit_channel' },
      maxSteps: 1,
    })
    throwIfTurnAborted(options.abortSignal)
    if (approvalPending()) return retried
    if (
      hasFabricatedApproval(retried.text) ||
      retried.toolRecords.length === 0
    ) {
      logger.warn('AI', '도구 호출 재시도 후에도 승인 제안이 없어 문구 차단')
      return { ...retried, text: FAILURE_NOTICE }
    }
    return retried
  } catch (error) {
    throwIfTurnAborted(options.abortSignal)
    // 중단은 삼키지 않는다. 여기서 FAILURE_NOTICE로 바꿔 버리면 호출부는
    // '승인 문구 조작 실패'로 오인하고, 그 문구를 세션에 원문으로 저장한다.
    // 중단일 테니 재사용할 예외 그대로 위로 올려 호출부가 '중단' 경로로
    // 처리하게 한다(중단 시에는 재시도도, 승인 카드 복구도 하지 않는다).
    if (
      isTurnAborted(error) ||
      error instanceof ToolExecutionInterruptedError
    ) {
      throw error
    }
    logger.warn(
      'AI',
      `승인 도구 호출 재시도 실패: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return { ...result, text: FAILURE_NOTICE }
  }
}
