import { config } from '../../../../config'
import type { ToolDefinition } from '../toolTypes'

const SEARCH_TIMEOUT_MS = 10_000
const MAX_RESULTS = 5

// Node의 fetch 기본 UA(undici/curl 계열)는 SearXNG limiter에 봇으로 차단된다.
// 브라우저로 위장하지 않고 정직하게 자신을 밝힌다.
const SEARCH_USER_AGENT =
  'LishiBot/1.0 (+https://github.com/litsyneko/lishibot)'

const JSON_CONTENT_TYPE = 'application/json'

// settings.yml의 search.formats에 json이 없으면 format=json 요청이 HTML 오류
// 페이지로 돌아온다. 그대로 .json()을 부르면 "Unexpected token <"만 남아
// 원인이 사라지므로, content-type을 먼저 확인해 원인을 그대로 사용자에게 알린다.
const JSON_FORMAT_SETTINGS_HINT =
  'SearXNG의 settings.yml에서 search.formats에 json을 추가하고 SearXNG를 재시작하세요.'

const FORBIDDEN_HINT =
  'json 형식이 활성화되지 않았거나 SearXNG limiter가 차단했을 수 있어요.'

const NON_JSON_BODY_PREVIEW_LIMIT = 200

type SearchResult = {
  title?: string
  url?: string
  content?: string
  snippet?: string
  description?: string
}

const formatResults = (results: SearchResult[]): string =>
  results
    .slice(0, MAX_RESULTS)
    .map((item, index) => {
      const title = item.title || '제목 없음'
      const url = item.url || 'URL 없음'
      const body = item.content || item.snippet || item.description || ''
      return `[${index + 1}] ${title} - ${url}\n${body}`
    })
    .join('\n\n')

const toSearchEndpoint = (rawUrl: string): URL => {
  const url = new URL(rawUrl)

  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/search'
  }

  return url
}

const extractResults = (data: unknown): string => {
  if (Array.isArray(data)) {
    return formatResults(data)
  }

  if (
    data &&
    typeof data === 'object' &&
    Array.isArray((data as { results?: unknown }).results)
  ) {
    return formatResults((data as { results: SearchResult[] }).results)
  }

  return JSON.stringify(data, null, 2)
}

// fetch 결과는 성공(JSON) / 실패(이유) 둘 중 하나로 파싱해 넘긴다.
// 호출자는 분기 한 번으로 상태를 알 수 있다.
type SearchFetchOutcome =
  | { readonly kind: 'parsed'; readonly data: unknown }
  | { readonly kind: 'rejected'; readonly message: string }

const previewBody = (body: string): string => {
  const flattened = body.replace(/\s+/g, ' ').trim()

  if (!flattened) return '(빈 응답)'

  return flattened.length > NON_JSON_BODY_PREVIEW_LIMIT
    ? `${flattened.slice(0, NON_JSON_BODY_PREVIEW_LIMIT)}…`
    : flattened
}

const describeHttpFailure = (status: number, statusText: string): string => {
  if (status === 403) {
    return `웹 검색 요청이 거부됐어요: HTTP ${status} ${statusText}. ${FORBIDDEN_HINT} ${JSON_FORMAT_SETTINGS_HINT}`
  }

  if (status === 429) {
    return `웹 검색 요청이 제한됐어요: HTTP ${status} ${statusText}. 잠시 뒤 다시 시도하거나 SearXNG limiter의 rate 제한을 확인하세요.`
  }

  if (status >= 500) {
    return `웹 검색이 SearXNG 서버 오류로 실패했어요: HTTP ${status} ${statusText}. SearXNG가 실행 중인지 확인하세요.`
  }

  return `웹 검색 요청이 실패했어요: HTTP ${status} ${statusText}. SearXNG 주소와 서버 상태를 확인하세요.`
}

const describeNonJsonResponse = (
  status: number,
  contentType: string,
  body: string
): string => {
  const forbiddenHint = status === 403 ? `${FORBIDDEN_HINT} ` : ''

  return [
    `SearXNG가 JSON이 아닌 응답을 반환했어요. (status: ${status}, content-type: ${
      contentType || '없음'
    }) ${forbiddenHint}${JSON_FORMAT_SETTINGS_HINT}`,
    `응답 본문 미리보기: ${previewBody(body)}`,
  ].join('\n')
}

const readSearchOutcome = async (
  response: Response
): Promise<SearchFetchOutcome> => {
  const contentType = response.headers.get('content-type') ?? ''

  if (!contentType.includes(JSON_CONTENT_TYPE)) {
    return {
      kind: 'rejected',
      message: describeNonJsonResponse(
        response.status,
        contentType,
        await response.text()
      ),
    }
  }

  if (!response.ok) {
    return {
      kind: 'rejected',
      message: describeHttpFailure(response.status, response.statusText),
    }
  }

  return { kind: 'parsed', data: await response.json() }
}

export const webSearchTool: ToolDefinition = {
  declaration: {
    name: 'web_search',
    description: '최신 정보 확인을 위해 웹 검색을 수행합니다. (SearXNG 기반)',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '검색할 쿼리',
        },
      },
      required: ['query'],
    },
  },
  permission: {
    requireManageGuild: false,
    requireAdmin: false,
    risk: 'info',
  },
  async execute(args, context) {
    const query = args.query as string

    if (!query) {
      return {
        success: false,
        message: '검색 쿼리가 제공되지 않았습니다.',
      }
    }

    const serxngUrl = config.serxngUrl

    if (!serxngUrl) {
      return {
        success: false,
        message: '웹 검색 서비스(SearXNG)가 설정되지 않았습니다.',
      }
    }

    try {
      const url = toSearchEndpoint(serxngUrl)
      url.searchParams.append('q', query)
      url.searchParams.append('format', 'json')

      const signal =
        context.abortSignal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS)

      const response = await fetch(url.toString(), {
        signal,
        headers: {
          'User-Agent': SEARCH_USER_AGENT,
          Accept: JSON_CONTENT_TYPE,
        },
      })

      const outcome = await readSearchOutcome(response)

      if (outcome.kind === 'rejected') {
        return {
          success: false,
          message: outcome.message,
        }
      }

      const resultsText = extractResults(outcome.data)

      return {
        success: true,
        message: '웹 검색을 성공적으로 수행했습니다.',
        summary: resultsText || '검색 결과가 없습니다.',
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      return {
        success: false,
        message: `웹 검색 중 오류 발생: ${errorMessage}`,
      }
    }
  },
}
