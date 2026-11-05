/**
 * AI 응답 루프 가드 — 같은 내용이 끝없이 복제되는 응답과 지나치게 긴 응답을
 * 판정한다.
 *
 * 설계 의사결정:
 * - 순수 함수 — 판정만 하지, 응답을 고치거나 중단시키지 않는다. 중단은
 *   호출부가 abortSignal로 수행하고, 이 모듈은 '왜' 중단할지만 알려 준다.
 * - 오탐(정상 응답을 잘라버림)이 오검출(런어웨이 못 잡음)보다 나쁘다. 정상
 *   응답도 우연히 6~120자 주기를 가질 수 있으므로, 주기 탐색 범위·최소 길이·
 *   3회 반복 요건을 함께 두어 판정 창을 좁게 잡는다.
 * - logger를 쓰지 않는다. 판정이 왜 났는지는 detail 문자열로만 전달한다.
 */

export type LoopGuardKind = 'overlong' | 'repetition'

/** 판정 결과. undefined는 '이상 없음(정상)'을 뜻한다. */
export type LoopGuardVerdict =
  | {
      readonly kind: LoopGuardKind
      readonly detail: string
      /** repetition일 때만 존재한다. 반복 단위(주기) 길이(정규화 기준). */
      readonly repeatUnitLength?: number
    }
  | undefined

/** 사용자에게 붙일 한국어 안내 문구. */
export const LOOP_REPETITION_NOTICE =
  '✂️ 같은 내용이 계속 반복되어 응답을 멈췄어요.'
export const LOOP_OVERLONG_NOTICE = '✂️ 응답이 지나치게 길어져 중간에 멈췄어요.'

/**
 * 검사 대상은 응답 꼬리뿐이다. 앞부분이 정상인 채로 끝에서만 망가지는 경우가
 * 실제 런어웨이 패턴이므로 전체를 훑으면 오탐 비용만 늘어난다.
 */
const TAIL_WINDOW = 400

/**
 * 반복 주기 하한(정규화 문자 수).
 * 더 작게 두면 표·목록 마커("- 항목:")처럼 짧은 블록이 정상 산문과 구분이
 * 안 된다. 6이면 3회 반복에 최소 18자가 필요하므로, 'ㅋㅋㅋㅋㅋㅋ' 같은 6자짜리
 * 단일 토큰 러너웨이는 여기서 걸리지 않는다 — 그 토큰이 자라 18자를 넘어서는
 * 순간부터 잡힌다. 오탐을 감수한 의도적 선택이다.
 */
const MIN_PERIOD = 10

/**
 * 반복 주기 상한. 120자를 넘는 주기는 사실상 자연스러운 산문이므로 검사해도
 * 이득이 없고, 주기마다 문자열 비교를 하므로 비용만 든다.
 */
const MAX_PERIOD = 120

/** 동일 블록이 연속으로 몇 번 나와야 반복인가. 2회면 정상 산문과 구분이 안 된다. */
const REPEAT_REQUIRED = 3

/**
 * 반복 판정 최소 정규화 길이.
 * 3회 반복이 나오더라도 응답이 이보다 짧으면 자르지 않는다. 짧은 응답을
 * 자르면 사용자가 받은 정보가 사라지는 반면, 200자 미만의 응답은 어차피
 * Discord 2000자 상한 안에 통째로 들어가 runaway 피해가 작다.
 * 본문(text)에 적용되는 값이고, thinking은 더 넉넉한 값을 쓴다
 * (MIN_NORM_LENGTH_BY_TARGET 참고).
 */
const MIN_NORM_LENGTH = 300

/**
 * 과장(overlong) 상한. 모델이 16k 토큰을 다 쓰면 수천 자가 되는데, 그
 * 이상은 사용자가 읽을 수 없는 지점이고 Discord 메시지 상한(2000자)도
 * 이미 여러 배 넘는다. 실사용 조용한 긴 설명(긴 코드 블록·표)도 이 안이다.
 */
const MAX_SOFT_LENGTH = 6000

type NormalizedTail = {
  /** 공백·개행을 제거하고 소문자로 내린 문자열. */
  readonly value: string
  /** value[i]가 원문 tail의 몇 번째 문자였는지. 반복 시작 위치를 되돌릴 때 쓴다. */
  readonly origin: readonly number[]
}

type RepetitionMatch = {
  /** 반복 단위 길이. */
  readonly period: number
  /** 반복이 시작되는 원문 인덱스. */
  readonly startIndex: number
}

/**
 * 판정 입력에서 제거할 장식 문자. 사람이 긋는 구분선과 봇이 긋는 구분선을
 * 정규화 단계에서 구분할 수 없으므로, 애초에 지운다.
 *
 * 제거하는 이유: 긴 구조화 응답이 '────────' 처럼 같은 줄 문자를 여러 번 늘어놓으면
 * 정규화 결과가 주기 3~4의 동일한 블록이 되어 '반복'으로 오탐된다. 이 문자는
 * 답변이 아니라 서식이므로 판정에서 빼면 오탐만 줄고 오검출 위험은 없다.
 * '※'도 화살표 머리(→)와 같은 표식으로 함께 제거한다.
 */
const DECORATION_PATTERN = /[─━┄┈┅┉┊┋┌┐└┘├┤┬┴┼※→⇒]/u

/**
 * 판정 대상 종류. 본문과 thinking은 성격이 달라 임계값이 다르다.
 * - text: 사용자에게 그대로 노출되는 답변. 오탐 비용이 크다(답이 사라짐).
 * - reasoning: 사고 과정. 본문이 아니며 최종 화면에서는 버려진다. 되풀이되는
 *   문장을 고쳐 쓰는 경향이 있어 오탐 확률이 text보다 훨씬 높다.
 */
export type LoopGuardTarget = 'reasoning' | 'text'

/**
 * 판정 대상별 임계값. 같은 판정 로직(classifyLoopGuard)을 쓰되 창만 다르게 준다.
 *
 * reasoning에서 MIN_NORM_LENGTH를 높인 이유: 사고 과정은 본문과 문법이 다르다.
 * "같은 논리를 다시 확인하자 / 아 잠깐 그건 틀렸다 / 다시 확인하자" 식으로 같은
 * 뼈대를 고쳐 쓰는 문장을 수십 번 잇는 게 정상이다. 본문 임계값(정규화 200자)을
 * 그대로 쓰면 이런 정상 사고가 3회 반복으로 잡혀 provider가 도중 잘린다 — 사용자는
 * 정답을 받지도 못한 채 '잘렸어요'만 본다.
 *
 * 260자로 정한 근거: 꼬리 TAIL_WINDOW(400자)를 정규화하면 실측 297자까지 나온다.
 * 그 값에 3p가 들어가려면 p <= 99여야 하는데, 사고의 반복 단위는 보통 20~30자
 * 라 대체로 가능하다. 400 이상으로 잡으면 사고 판정이 **구조적으로 영영 발화하지
 * 않고**(실측: 30회 러너웨이가 통과), 300으로 잡으면 297자를살짝 못 미달해 같은
 * 러너웨이가 통과했다. 260은 그 사이에서 정상 사고는 확실히 통과하고 진짜 루프만
 * 잡히는 지점이다. 근거는 실측 스윕(러너웨이 8~30회 / 정상 사고 2~20회 반복)에 있다.
 *
 * MAX_PERIOD는 그대로 둔다. 사고 문장은 주기가 짧고 규칙적인 편이라 주기 상한을
 * 낮추면(예: 40) 같은 뼈대 반복을 더 자주 잡지만, 그건 오탐 구간을 넓히는 것이라
 * 오히려 해롭다. 주기가 길수록 '사고'가 아니라 '같은 말 반복'일 가능성이 높으므로
 * 상한을 유지한다.
 */
const MIN_NORM_LENGTH_BY_TARGET: Record<LoopGuardTarget, number> = {
  text: MIN_NORM_LENGTH,
  reasoning: 260,
}

/** 판정 대상별 최소 정규화 길이. */
export function minNormLengthFor(target: LoopGuardTarget): number {
  return MIN_NORM_LENGTH_BY_TARGET[target]
}

/**
 * tail만 정규화한다. toLowerCase가 한 문자를 여러 문자로 펼칠 수 있어
 * (예: 'İ') 원문 인덱스를 한 글자씩 붙여야 두 배열의 길이가 어긋나지 않는다.
 */
function normalizeTail(text: string): NormalizedTail {
  const tail =
    text.length > TAIL_WINDOW ? text.slice(text.length - TAIL_WINDOW) : text
  const value: string[] = []
  const origin: number[] = []

  for (let i = 0; i < tail.length; i += 1) {
    const lowered = tail[i].toLowerCase()
    for (const char of lowered) {
      if (/\s/u.test(char)) continue
      if (DECORATION_PATTERN.test(char)) continue
      value.push(char)
      origin.push(i)
    }
  }

  return { value: value.join(''), origin }
}

/**
 * 꼬리의 마지막 3p 자가 동일 블록 3개로 이루어지는 가장 짧은 p를 찾는다.
 * 짧은 p를 먼저 채택하는 이유는 오탐 최소화다 — 같은 반복이라도 더 큰
 * 주기를 택하면 불필요하게 앞부분까지 잘린다.
 */
function findRepetition(
  text: string,
  minNormLength: number
): RepetitionMatch | undefined {
  const tail = normalizeTail(text)
  const value = tail.value
  if (value.length < minNormLength) {
    return undefined
  }

  const tailOffset = text.length - Math.min(text.length, TAIL_WINDOW)
  const maxPeriod = Math.min(
    MAX_PERIOD,
    Math.floor(value.length / REPEAT_REQUIRED)
  )

  for (let period = MIN_PERIOD; period <= maxPeriod; period += 1) {
    // 짧은 주기(20자 미만)일 때는 최소 4회 반복이어야 런어웨이로 판정 (코드 블록/리스트 오탐 방지)
    const required = period < 20 ? 4 : REPEAT_REQUIRED
    if (value.length < period * required) continue

    const blockLength = period * required
    const blockStart = value.length - blockLength
    const block = value.slice(blockStart)
    const unit = value.slice(blockStart, blockStart + period)
    if (block === unit.repeat(required)) {
      return { period, startIndex: tailOffset + tail.origin[blockStart] }
    }
  }

  return undefined
}

/**
 * 응답이 루프에 빠졌거나 과장인지 판정한다. 이상 없으면 undefined.
 * 반복은 길이와 관계없이 마지막 400자로 판정한다. 긴 응답의 끝에서 시작된
 * 반복을 overlong로 가리면 원문이 다음 턴에 그대로 저장된다.
 *
 * target은 판정 대상(본문/thinking)을 가리킨다. 판정 로직은 하나만 두고 임계값만
 * 갈라 같은 임계값 상수를 두 벌 만들지 않는다 — 그렇게 하면 두 값이 서로 새고
 * 나중에 한쪽만 고쳐지는 드리프트가 생긴다.
 */
export function classifyLoopGuard(
  text: string,
  target: LoopGuardTarget = 'text'
): LoopGuardVerdict {
  const match = findRepetition(text, minNormLengthFor(target))
  if (match !== undefined) {
    return {
      kind: 'repetition',
      detail: `${match.period}자 단위가 3회 이상 연속 반복`,
      repeatUnitLength: match.period,
    }
  }

  if (text.length > MAX_SOFT_LENGTH) {
    return {
      kind: 'overlong',
      detail: `${text.length}자 — 한계(${MAX_SOFT_LENGTH}자) 초과`,
    }
  }

  return undefined
}

/**
 * 반복이 계속 쌓일 위험이 있는지 — 즉 델타를 끊고 provider를 멈춰야 하는지.
 * overlong는 이미 다 만들어진 답이므로 '안심' 쪽이다.
 */
export function isLoopGuardBlocking(verdict: LoopGuardVerdict): boolean {
  return verdict !== undefined && verdict.kind === 'repetition'
}

/** 판정에 맞는 한국어 안내 문구를 돌려준다. 판정이 없으면 빈 문자열. */
export function describeLoopGuard(verdict: LoopGuardVerdict): string {
  if (verdict === undefined) {
    return ''
  }
  return verdict.kind === 'repetition'
    ? LOOP_REPETITION_NOTICE
    : LOOP_OVERLONG_NOTICE
}

/**
 * 반복이 시작되는 지점 뒤를 잘라 앞부분만 남긴다. 반복이 없으면 원문을 그대로
 * 돌려준다 — 잘라낼 이유가 없는 입력에 잘라내기를 적용하지 않기 위함.
 */
export function truncateAtLoopStart(text: string): string {
  const match = findRepetition(text, minNormLengthFor('text'))
  if (match === undefined) {
    return text
  }
  return text.slice(0, match.startIndex).trimEnd()
}
