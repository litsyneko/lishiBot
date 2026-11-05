/**
 * 손상된 응답 분류기 — 세션에 저장하면 안 되는 응답을 판정하고, 대신 저장할
 * 마커 문장을 만든다.
 *
 * 왜 loopGuard.ts가 아니라 별도 모듈인가:
 * - loopGuard는 "이 텍스트가 반복인가?"라는 텍스트 판정만 한다. 순수 함수이고
 *   logger도 없다. 스트리밍 렌더러가 매 델타마다 불러야 하는 hot path다.
 * - 여기서는 판정 결과가 아니라 **세션 오염 방지 정책**을 다룬다. "모델에게 이걸
 *   대화 기록으로 보여줘도 되는가, 아니면 실패 기록으로 바꿔야 하는가"는 판정과
 *   전혀 다른 질문이다. 두 관심사를 한 파일에 섞으면 렌더러 hot path가 세션
 *   저장 규칙까지 끌어안게 된다.
 *
 * 왜 분류기를 다시 부르는가(렌더러 결과를 그대로 전달하지 않는 이유):
 * - 1단계/2단계의 반복 판정은 **스트리밍 경로에만** 존재한다. openStream이 없는
 *   generate 경로, 스트리밍이 죽어서 generate로 떨어진 폴백 경로에는 렌더러가
 *   아예 없다. 이들에게는 판정을 전달할 방법이 없으므로, 어차피 되돌아가는
 *   경로가 필요하다.
 * - 되돌아가는 대상을 '세션에 저장될 텍스트 자체'로 잡으면, 판정 대상과 저장
 *   대상이 어긋날 수 없다. 지금 구조에서 저장되는 문자열은 clean된 텍스트
 *   (think/도구문법 제거 후)이고, 그것을 그대로 판정한다.
 * - 비용도 무시할 만하다. 400자 꼬리에 주기 6~120을 한 번 훑는 것뿐이고, 턴당
 *   한 번만 돈다.
 * - 반대(렌더러 결과 전달)의 장점은 '중복 판정이 없다'였지만, 위 두 항목을
 *   포기해야 하므로 선택하지 않았다. 참고로 둘이 어긋나지는 않는다 — 렌더러가
 *   잘랐다면 저장 대상 텍스트에도 반복이 그대로 남아 있어 양쪽 모두 같은 판정
 *   ('loop-guard')을 낸다.
 */
import { classifyLoopGuard } from './loopGuard'

/** 손상 유형. undefined는 '정상이라 원문을 저장해도 된다'. */
export type DamagedResponse =
  | {
      /** 사용자가 멈췄거나 데드라인·내부 규칙으로 중단됨. 원문 자체가 없다. */
      readonly kind: 'aborted'
    }
  | {
      /** 반복 또는 과장 때문에 잘린 응답. 앞부분만 의미가 있다. */
      readonly kind: 'loop-guard'
    }
  | {
      /** 본문이 비었음(토큰 예산 소진 등). */
      readonly kind: 'empty'
    }
  | undefined

export type DamagedResponseInput = {
  /** 턴이 중단됐는지. 중단 사유는 담지 않는다 — 저장 마커에는 구분 불필요. */
  readonly aborted?: boolean
  /** 판정 대상. 세션에 저장될 텍스트를 넘긴다. */
  readonly text: string
}

/**
 * 판정 우선순위: aborted → loop-guard → empty.
 *
 * aborted를 먼저 보는 이유 — 중단된 턴에는 의미 있는 원문이 없다. 반복이 겹쳐
 * 있어도 '중단'이라는 사실이 원인을 더 정확히 말해 주므로 우선한다.
 * empty를 마지막에 보는 이유 — 빈 문자열은 다른 두 상태의 자연스러운 결과일 수
 * 있어(중단 직후의 빈 버퍼), 구체적인 원인이 있으면 그걸 먼저 알려야 한다.
 *
 * overlong는 여기서 걸러 undefined를 낸다. 3단계에서 overlong를 손상으로
 * 분류했던 것은 실수였고(1단계의 overlong는 provider가 이미 끝까지 만든 정상
 * 답변이었다), 그대로 두면 6000자를 넘는 정상 답변이 세션에서 마커로 대체돼
 * 모델이 자기 정답을 잊어버린다. 잘린 게 아니라 긴 것뿐이므로 원문 저장이 옳다.
 */
export function classifyDamagedResponse(
  input: DamagedResponseInput
): DamagedResponse {
  if (input.aborted === true) {
    return { kind: 'aborted' }
  }
  if (classifyLoopGuard(input.text)?.kind === 'repetition') {
    return { kind: 'loop-guard' }
  }
  if (input.text.trim().length === 0) {
    return { kind: 'empty' }
  }
  return undefined
}

/**
 * 손상 유형마다 세션에 대신 남길 한국어 문장.
 *
 * 이 문자열은 사용자에게 보이는 문구가 아니라 **모델이 다음 턴에 읽는 assistant
 * 턴 내용**이다. 목적이 '이건 답이 아니라 실패 기록'이라는 사실을 모델에게
 * 분명히 전달해, 자기 루프를 대화 기록으로 보고 이어서 반복하는 것을 막는 것.
 * 그래서 (1) 대괄호로 '기록'임을 표시하고 (2) 괄호 안에서 원인을 말하며
 * (3) 문장 자체를 완결시켜 '답변처럼 읽히는' 형태를 피한다.
 *
 * 문구는 **저장되는 내용과 반드시 일치해야 한다.** 예전처럼 "앞부분만 참고하세요"
 * 라면서 앞부분은 저장하지 않으면, 모델이 없는 내용을 추측하게 되어 목적을
 * 반대로 해친다. 반복(kind='loop-guard')은 앞부분도 함께 검사해 깨끗할 때만
 * 저장한다(AiMentionExtension.recordAssistantTurn 참고) — 앞부분이 아직 반복이면
 * 저장하지 않으므로, 문구는 그 경우까지 포함해 '저장하지 않았어요'로 쓴다.
 *
 * 사람이 읽어도 자연스러워야 한다 — 4단계에서 화면에도 쓰일 수 있기 때문.
 * undefined(정상)이면 빈 문자열을 돌려준다. '정상인데 마커가 필요한' 경우는
 * 없으므로 호출부는 원문을 그대로 쓴다.
 */
const DAMAGED_MARKERS: Record<
  Exclude<DamagedResponse, undefined>['kind'],
  string
> = {
  aborted: '⏹️ (사용자가 응답을 중단해서 답을 끝내지 못했어요.)',
  'loop-guard':
    '✂️ (같은 내용이 반복돼 응답이 중간에 잘렸어요. 앞부분도 반복이면 그 내용은 저장하지 않았어요.)',
  empty: '💭 (이번엔 대답을 만들지 못했어요.)',
}

export function describeDamagedResponse(damaged: DamagedResponse): string {
  return damaged === undefined ? '' : DAMAGED_MARKERS[damaged.kind]
}
