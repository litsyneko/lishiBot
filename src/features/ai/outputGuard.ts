/**
 * AI 출력 품질 가드 — 예약 토큰/내부 프린터 식별자/특수 토큰/금지 제어 문자/
 * 과도한 U+FFFD가 포함된 응답을 reject 한다.
 *
 * 보안 의사결정:
 * - strip 하지 않고 throw: 부분 손상 출력은 안전하지 않다.
 * - raw malformed 콘텐츠를 로그에 남기지 않는다 (kind/detail만).
 * - 합법적 다국어(한국어/영어/이모지/코드/태국어 등)는 비한국어라는
 *   이유만으로 거부하지 않는다.
 * - 순수 함수 — 분류/검증만, 부작용 없음.
 */

export type OutputIssueKind =
  | 'control-char'
  | 'dialog-printer'
  | 'excessive-replacement'
  | 'special-token'
  | 'unused-token'

export type OutputIssue = {
  readonly detail: string
  readonly kind: OutputIssueKind
}

export class OutputGuardError extends Error {
  public readonly issue: OutputIssue

  public constructor(issue: OutputIssue) {
    super(`AI 출력 가드 위반(${issue.kind}): ${issue.detail}`)
    this.name = 'OutputGuardError'
    this.issue = issue
  }
}

// <unused1234>, [unused1234] — tokenizer placeholder 누출
const UNUSED_TOKEN = /[[<]unused\d+[\]>]/u

// ChatML / GPT 원시 특수 토큰 노출
const SPECIAL_TOKEN =
  /<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>|<\|fim_prefix\|>|<\|fim_middle\|>|<\|fim_suffix\|>/u

// 내부 렌더러/프린터 식별자
const DIALOG_PRINTER = /DialogPrinter/u

// 금지 C0/C1 제어 문자 — tab(09), LF(0A), CR(0D)은 허용
// eslint-disable-next-line no-control-regex
const C0_C1 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u

const REPLACEMENT_CHAR = '\uFFFD'
const REPLACEMENT_THRESHOLD = 3

function countReplacement(text: string): number {
  let count = 0
  let idx = text.indexOf(REPLACEMENT_CHAR)
  while (idx !== -1) {
    count++
    if (count > REPLACEMENT_THRESHOLD) {
      return count
    }
    idx = text.indexOf(REPLACEMENT_CHAR, idx + 1)
  }
  return count
}

function checkReject(text: string): OutputIssue | undefined {
  if (UNUSED_TOKEN.test(text)) {
    return { kind: 'unused-token', detail: '<unused> placeholder 감지' }
  }
  if (SPECIAL_TOKEN.test(text)) {
    return { kind: 'special-token', detail: 'ChatML 특수 토큰 노출' }
  }
  if (DIALOG_PRINTER.test(text)) {
    return { kind: 'dialog-printer', detail: '내부 렌더러 식별자 노출' }
  }
  if (C0_C1.test(text)) {
    return { kind: 'control-char', detail: '금지된 제어 문자 포함' }
  }
  const replaceCount = countReplacement(text)
  if (replaceCount >= REPLACEMENT_THRESHOLD) {
    return {
      detail: `U+FFFD ${replaceCount}회 이상`,
      kind: 'excessive-replacement',
    }
  }
  return undefined
}

/**
 * 텍스트의 문제를 분류한다. 문제가 있으면 OutputIssue, 없으면 undefined.
 * 합법적 다국어 텍스트는 비한국어라는 이유만으로 거부되지 않는다.
 */
export function classifyOutputIssue(text: string): OutputIssue | undefined {
  return checkReject(text)
}

/**
 * 사용자 노출에 안전한지 검증한다. 문제가 있으면 OutputGuardError throw.
 * 빈 문자열은 통과 — 빈 응답 자체는 가드의 책임이 아니다.
 */
export function assertOutputSafe(text: string): void {
  const issue = checkReject(text)
  if (issue !== undefined) {
    throw new OutputGuardError(issue)
  }
}
