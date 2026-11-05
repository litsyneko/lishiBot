import { logger } from '../../utils/logger'
import {
  ActionRowBuilder,
  ButtonBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from '@discordjs/builders'
import { MessageFlags, SeparatorSpacingSize } from 'discord.js'

// 실측 사실: Ollama은 <think> 태그를 전혀 쓰지 않는다. OpenAI-호환 엔드포인트
// (/v1/chat/completions)로는 thinking이 content가 아니라 별도 reasoning 필드로
// 오고, 네이티브 /api/chat 에서는 thinking 필드다. 따라서 이 함수는
// Ollama 경유 시 완전 무동작이다 — 스트리밍은 providerCore이 reasoning 델타를
// 따로 흘려보내므로(→ streamRenderer의 인용줄) 여기까지 오지 않는다.
// 이 함수는 태그를 씌우는 클라우드 provider 대비용으로 코드를 남긴다.
const THINK_PATTERN = /<think>[\s\S]*?<\/think>/gi

export function stripThinkTags(content: string): string {
  return content.replace(THINK_PATTERN, '').trim()
}

const HR_PATTERN = /^[ \t]*---[ \t]*$/gmu

/**
 * Components V2 최상위 컴포넌트 상한.
 *
 * Discord은 최상위 컴포넌트를 10개로 제한한다. 2단계부터 모든 스트리밍 편집이
 * Components V2 payload로 나가는데, toComponentV2는 구분선마다 SeparatorBuilder를
 * 하나씩 넣으므로 최상위 개수가 2n+1이 된다. 구분선 5개면 11개, 중지 버튼 행까지
 * 붙으면 12개 — HTTP 400이다. 이 오류는 결정적이라 rate limit도 메시지 삭제도 아니고,
 * pushOnce가 실패 후 다음 델타마다 다시 시도해 1.5초마다 경고를 찍는다.
 *
 * 상한 상수를 두고 초과분을 마지막 TextDisplay에 병합한다. 구분선 렌더링을
 * 그대로 버리면(단순히 SeparatorBuilder를 추가하지 않기) 이미 쓰는 구분선이
 * 사라지므로, 내용이 사라지지 않는 병합을 택한다.
 */
const MAX_V2_TOP_LEVEL_COMPONENTS = 10

/**
 * 컴포넌트 상한을 지키면서 초과분을 마지막 TextDisplay에 다시 붙인다.
 * 상한을 넘지 않으면 원본을 그대로 반환한다(불필요한 복사 없음).
 *
 * reserve는 '나중에 호출부가 덧붙일 컴포넌트 수'다. 중지 버튼 행(+1)을 나중에
 * 붙이는 스트리밍 경로는 reserve=1로 불러야 상한을 넘지 않는다 — 여기서 10개를
 * 꽉 채워 버리면 버튼이 붙는 순간 11개가 되어 다시 400이 된다.
 */
function clampV2Components(
  flat: V2MessageComponent[],
  reserve: number
): V2MessageComponent[] {
  const limit = Math.max(1, MAX_V2_TOP_LEVEL_COMPONENTS - reserve)
  if (flat.length <= limit) {
    return flat
  }
  const kept = flat.slice(0, limit)
  const overflow = flat
    .slice(limit)
    .filter((c): c is TextDisplayBuilder => c instanceof TextDisplayBuilder)
    .map((c) => c.data.content ?? '')
    .filter((content) => content.length > 0)
  if (overflow.length === 0) {
    return kept
  }
  // 마지막 TextDisplay에 초과분을 이어붙인다. 구분선을 문자로 되살리면
  // clamp 이후에도 사용자가 구분이 보이며, 내용 유실도 없다.
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const component = kept[i]
    if (component instanceof TextDisplayBuilder) {
      kept[i] = new TextDisplayBuilder().setContent(
        `${component.data.content ?? ''}\n\n---\n\n${overflow.join(
          '\n\n---\n\n'
        )}`
      )
      return kept
    }
  }
  return kept
}

/**
 * Components V2 메시지의 최상위 컴포넌트 조합.
 *
 * ActionRow를 포함하는 이유: 스트리밍 응답에 중지 버튼을 붙이려면 ActionRow가
 * 필요하다(Components V2에서 버튼은 단독으로 둘 수 없다). 순서는 TextDisplay
 * 뒤에 ActionRow가 오는 쪽이 유효하므로, 이 함수가 만들어 낸 배열의 '맨 끝'을
 * 버튼 행이 차지하도록 호출부가 조립한다.
 */
export type V2MessageComponent =
  | ActionRowBuilder<ButtonBuilder>
  | SeparatorBuilder
  | TextDisplayBuilder

export function toComponentV2(
  text: string,
  reserve = 0
): {
  components: V2MessageComponent[]
  flags: number
} {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return { components: [], flags: MessageFlags.IsComponentsV2 }
  }

  const hasHr = HR_PATTERN.test(trimmed)
  HR_PATTERN.lastIndex = 0

  if (!hasHr) {
    return {
      components: [new TextDisplayBuilder().setContent(trimmed)],
      flags: MessageFlags.IsComponentsV2,
    }
  }

  const sections = trimmed
    .split(HR_PATTERN)
    .map((s) => s.trim())
    .filter(Boolean)
  logger.info('V2', `Components V2 변환: 분리선 ${sections.length - 1}개`)
  const flat: V2MessageComponent[] = []

  for (let i = 0; i < sections.length; i++) {
    flat.push(new TextDisplayBuilder().setContent(sections[i]))
    if (i < sections.length - 1) {
      flat.push(
        new SeparatorBuilder()
          .setDivider(true)
          .setSpacing(SeparatorSpacingSize.Small)
      )
    }
  }

  // 상한 클램프는 마지막에 한 번만 건다. 앞쪽에서 잘라 버리면 중간의 내용이
  // 조용히 사라져서, 초과분은 마지막 TextDisplay로 몰아서 살린다.
  const clamped = clampV2Components(flat, reserve)
  if (clamped.length !== flat.length) {
    logger.warn(
      'V2',
      `Components V2 상한(${MAX_V2_TOP_LEVEL_COMPONENTS}) 초과로 병합: 구분선 ${
        sections.length - 1
      }개 → 컴포넌트 ${clamped.length}개`
    )
  }

  return { components: clamped, flags: MessageFlags.IsComponentsV2 }
}

/**
 * AI 응답에서 누출된 원시 도구 호출 문법만 안전하게 제거합니다.
 * 마크다운 코드 블록 내부의 정상적인 코드나 JSON 예제는 훼손하지 않습니다.
 */
export function stripToolCallSyntax(text: string): string {
  // 코드 블록(```...```)을 임시 플레이스홀더로 보호하여 정상 코드 훼손 방지
  const codeBlocks: string[] = []
  let protectedText = text.replace(/```[\s\S]*?```/gu, (match) => {
    const idx = codeBlocks.length
    codeBlocks.push(match)
    return `__CODE_BLOCK_${idx}__`
  })

  // 코드 블록 바깥에서 유출된 단독 JSON 도구 호출 객체 제거
  if (
    /^\s*\{\s*"(?:function|name|tool|parameters|arguments)"\s*:/mu.test(
      protectedText
    )
  ) {
    const braceIdx = protectedText.indexOf('{')
    if (braceIdx !== -1) {
      let depth = 0
      let end = -1
      for (let i = braceIdx; i < protectedText.length; i++) {
        if (protectedText[i] === '{') depth++
        else if (protectedText[i] === '}') {
          depth--
          if (depth === 0) {
            end = i + 1
            break
          }
        }
      }
      if (end !== -1) {
        protectedText =
          protectedText.slice(0, braceIdx) + protectedText.slice(end)
      }
    }
  }

  // 코드 블록 바깥의 알려진 단독 도구 함수 호출 라인 제거
  protectedText = protectedText.replace(
    /^[ \t]*(?:edit|create|delete|lookup|list|get|reorder|bind|send)_[a-zA-Z0-9_]+\s*\([\s\S]*?\)\s*$/gmu,
    ''
  )

  // 보호했던 코드 블록 복원
  const restored = protectedText.replace(/__CODE_BLOCK_(\d+)__/gu, (_, idx) => {
    return codeBlocks[Number(idx)] ?? ''
  })

  return restored.replace(/\n{3,}/gu, '\n\n').trim()
}
