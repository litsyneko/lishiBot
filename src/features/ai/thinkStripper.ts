import { TextDisplayBuilder, SeparatorBuilder } from '@discordjs/builders'
import { MessageFlags, SeparatorSpacingSize } from 'discord.js'
import { logger } from '../../utils/logger'

const THINK_PATTERN = /<think>[\s\S]*?<\/think>/gi

export function stripThinkTags(content: string): string {
  return content.replace(THINK_PATTERN, '').trim()
}

const HR_PATTERN = /^[ \t]*---[ \t]*$/gmu

export function toComponentV2(text: string): { components: (TextDisplayBuilder | SeparatorBuilder)[]; flags: number } {
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

  const sections = trimmed.split(HR_PATTERN).map((s) => s.trim()).filter(Boolean)
  logger.info('V2', `Components V2 변환: 분리선 ${sections.length - 1}개`)
  const flat: (TextDisplayBuilder | SeparatorBuilder)[] = []

  for (let i = 0; i < sections.length; i++) {
    flat.push(new TextDisplayBuilder().setContent(sections[i]))
    if (i < sections.length - 1) {
      flat.push(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    }
  }

  return { components: flat, flags: MessageFlags.IsComponentsV2 }
}

/** AI 응답에서 JSON/함수 호출 문법을 제거해 사용자에게 노출되지 않도록 합니다. */
export function stripToolCallSyntax(text: string): string {
  let result = text
  result = result.replace(/```(?:json|python)?\s*[\s\S]*?\}\s*```/gu, '')
  result = result.replace(
    /^[ \t]*\w+\s*\([^)]*\)\s*$/gmu,
    (line) => (/^\w+\s*\(\s*\)\s*$/u.test(line.trim()) ? line : ''),
  )
  result = result.replace(
    /^[ \t]*\w+\s*\([\s\S]*?\)\s*$/gmu,
    (line, _m, offset) => {
      const before = result.slice(0, offset).trimEnd().split('\n').pop() ?? ''
      if (/=\s*$/u.test(before) || /["'`]\s*$/u.test(before)) return line
      if (/^(edit|create|delete|lookup|list|get|reorder|bind)_/iu.test(line.trim())) return ''
      return line
    },
  )
  result = result.replace(/\{\s*\w+\s*\([^)]*\)\s*\}/gu, '')
  if (/^\s*\{\s*"(?:function|name|tool|parameters)"\s*:/mu.test(result)) {
    const braceIdx = result.indexOf('{')
    if (braceIdx !== -1) {
      let depth = 0
      let end = -1
      for (let i = braceIdx; i < result.length; i++) {
        if (result[i] === '{') depth++
        else if (result[i] === '}') {
          depth--
          if (depth === 0) { end = i + 1; break }
        }
      }
      if (end !== -1) {
        result = result.slice(0, braceIdx) + result.slice(end)
      }
    }
  }
  return result.replace(/\n{3,}/gu, '\n\n').trim()
}
