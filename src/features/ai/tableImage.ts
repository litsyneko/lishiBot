import { logger } from '../../utils/logger'
import { toComponentV2 } from './thinkStripper'
import {
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} from '@discordjs/builders'
import { createCanvas } from '@napi-rs/canvas'
import { AttachmentBuilder, MessageFlags } from 'discord.js'

type Table = { headers: string[]; rows: string[][] }
const MAX_TABLES = 4
const MAX_IMAGES = 8
const MAX_COLUMNS = 6
const MAX_ROWS = 60
const MAX_PAGE_HEIGHT = 520
const FONT = '16px "Noto Sans CJK KR", "NanumSquare", sans-serif'
const BOLD_FONT = 'bold 16px "Noto Sans CJK KR", "NanumSquare", sans-serif'

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/u, '')
    .replace(/(?<!\\)\|$/u, '')
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.trim().replace(/\\\|/gu, '|'))
}

function isDivider(line: string, count: number): boolean {
  const parts = cells(line)
  return (
    parts.length === count && parts.every((part) => /^:?-{3,}:?$/u.test(part))
  )
}

function wrap(
  text: string,
  width: number,
  measure: (value: string) => number
): string[] {
  const result: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const char of paragraph) {
      if (line.length > 0 && measure(line + char) > width) {
        result.push(line)
        line = ''
      }
      line += char
    }
    result.push(line)
  }
  return result
}

function tableWidth(columns: number): number {
  return Math.min(1500, Math.max(680, columns * 260))
}

function measureRow(
  row: string[],
  textWidth: number,
  measure: (value: string) => number
): number {
  return Math.max(
    48,
    Math.max(...row.map((value) => wrap(value, textWidth, measure).length)) *
      24 +
      20
  )
}

function drawTable(table: Table): Buffer {
  const width = tableWidth(table.headers.length)
  const padding = 18
  const cellWidth = (width - 40) / table.headers.length
  const textWidth = cellWidth - padding * 2
  const probe = createCanvas(1, 1).getContext('2d')
  probe.font = FONT
  const measure = (value: string) => probe.measureText(value).width
  const allRows = [table.headers, ...table.rows]
  const wrapped = allRows.map((row) =>
    row.map((value) => wrap(value, textWidth, measure))
  )
  const heights = allRows.map((row) => measureRow(row, textWidth, measure))
  const height = 40 + heights.reduce((sum, value) => sum + value, 0)
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  // 배경은 요청대로 완전히 투명하게 유지한다.
  ctx.lineJoin = 'round'
  ctx.lineWidth = 3
  ctx.strokeStyle = '#17202b'
  ctx.fillStyle = '#ffffff'
  let y = 20
  for (let rowIndex = 0; rowIndex < wrapped.length; rowIndex += 1) {
    const rowHeight = heights[rowIndex]
    ctx.font = rowIndex === 0 ? BOLD_FONT : FONT
    for (let column = 0; column < wrapped[rowIndex].length; column += 1) {
      const x = 20 + column * cellWidth + padding
      wrapped[rowIndex][column].forEach((line, lineIndex) => {
        ctx.strokeText(line, x, y + 30 + lineIndex * 24)
        ctx.fillText(line, x, y + 30 + lineIndex * 24)
      })
    }
    y += rowHeight
    if (rowIndex < wrapped.length - 1) {
      ctx.beginPath()
      ctx.moveTo(20, y)
      ctx.lineTo(width - 20, y)
      ctx.lineWidth = 3
      ctx.strokeStyle = '#17202b'
      ctx.stroke()
      ctx.lineWidth = 1
      ctx.strokeStyle = '#ffffff'
      ctx.stroke()
      ctx.lineWidth = 3
      ctx.strokeStyle = '#17202b'
    }
  }
  return canvas.toBuffer('image/png')
}

function drawTablePages(table: Table): Buffer[] {
  const width = tableWidth(table.headers.length)
  const textWidth = (width - 40) / table.headers.length - 36
  const probe = createCanvas(1, 1).getContext('2d')
  probe.font = FONT
  const measure = (value: string) => probe.measureText(value).width
  const headerHeight = measureRow(table.headers, textWidth, measure)
  const pages: string[][][] = []
  let rows: string[][] = []
  let pageHeight = 40 + headerHeight
  for (const row of table.rows) {
    const height = measureRow(row, textWidth, measure)
    if (40 + headerHeight + height > MAX_PAGE_HEIGHT) {
      throw new Error('한 행이 표 이미지 높이 제한을 넘었습니다')
    }
    if (rows.length > 0 && pageHeight + height > MAX_PAGE_HEIGHT) {
      pages.push(rows)
      rows = []
      pageHeight = 40 + headerHeight
    }
    rows.push(row)
    pageHeight += height
  }
  if (rows.length > 0) pages.push(rows)
  return pages.map((pageRows) =>
    drawTable({ headers: table.headers, rows: pageRows })
  )
}

/** Markdown 표만 이미지로 치환한다. 코드 블록과 불완전한 표는 그대로 둔다. */
export function renderAiTables(content: string): {
  content: string
  files: AttachmentBuilder[]
} {
  const lines = content.split('\n')
  const output: string[] = []
  const files: AttachmentBuilder[] = []
  let renderedTables = 0
  let inCode = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*```/u.test(line)) inCode = !inCode
    if (inCode || renderedTables >= MAX_TABLES || i + 2 >= lines.length) {
      output.push(line)
      continue
    }
    const headers = cells(line)
    if (
      headers.length < 2 ||
      headers.length > MAX_COLUMNS ||
      !line.includes('|') ||
      !isDivider(lines[i + 1], headers.length)
    ) {
      output.push(line)
      continue
    }
    const rows: string[][] = []
    let end = i + 2
    while (end < lines.length && lines[end].includes('|')) {
      const row = cells(lines[end])
      if (row.length !== headers.length) break
      rows.push(row)
      end += 1
    }
    if (rows.length === 0 || rows.length > MAX_ROWS) {
      output.push(line)
      continue
    }
    try {
      const pages = drawTablePages({ headers, rows })
      if (files.length + pages.length > MAX_IMAGES) {
        output.push(line)
        continue
      }
      renderedTables += 1
      for (const page of pages) {
        const index = files.length + 1
        files.push(
          new AttachmentBuilder(page, { name: `ai-table-${index}.png` })
        )
        output.push(`[[AI_TABLE_IMAGE_${index}]]`)
      }
      i = end - 1
    } catch (error) {
      logger.warn(
        'AI',
        `표 이미지 생성 실패: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      output.push(line)
    }
  }
  return { content: output.join('\n'), files }
}

/** 표 이미지를 답변 문장 사이에 배치하는 Components V2 payload. */
export function toAiFinalMessage(content: string): {
  content: string
  components: (
    | ReturnType<typeof toComponentV2>['components'][number]
    | MediaGalleryBuilder
  )[]
  flags: number
  files: AttachmentBuilder[]
} {
  const rendered = renderAiTables(content)
  if (rendered.files.length === 0) {
    return { content: '', ...toComponentV2(content), files: [] }
  }
  const components: (
    | ReturnType<typeof toComponentV2>['components'][number]
    | MediaGalleryBuilder
  )[] = []
  const marker = /\[\[AI_TABLE_IMAGE_(\d+)\]\]/gu
  let start = 0
  for (const match of rendered.content.matchAll(marker)) {
    const before = rendered.content.slice(start, match.index).trim()
    if (before.length > 0) components.push(...toComponentV2(before).components)
    const index = Number(match[1])
    components.push(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(`attachment://ai-table-${index}.png`)
          .setDescription(`AI 답변 표 ${index}`)
      )
    )
    start = match.index + match[0].length
  }
  const after = rendered.content.slice(start).trim()
  if (after.length > 0) components.push(...toComponentV2(after).components)
  // V2 최상위 10개 제한을 넘으면 표 원문으로 되돌려 전송 실패를 피한다.
  if (components.length > 10) {
    return { content: '', ...toComponentV2(content), files: [] }
  }
  return {
    content: '',
    components,
    flags: MessageFlags.IsComponentsV2,
    files: rendered.files,
  }
}
