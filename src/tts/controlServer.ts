import { logger } from '../utils/logger'
import { type IncomingMessage, type ServerResponse, createServer } from 'http'

export type JoinPayload = {
  readonly guildId: string
  readonly voiceChannelId: string
  readonly textChannelId: string
}

export type LeavePayload = {
  readonly guildId: string
}

export type SetVoicePayload = {
  readonly userId: string
  readonly voiceId: string
}

export type ControlHandlers = {
  readonly onJoin: (payload: JoinPayload) => Promise<void>
  readonly onLeave: (payload: LeavePayload) => Promise<void>
  readonly onSetVoice: (payload: SetVoicePayload) => Promise<void>
  // /health 응답에 합쳐지는 상태(부팅 시각, 활성 세션 등). 메인봇이
  // 재시작/무응답 감지에 사용한다.
  readonly onHealth: () => Record<string, unknown>
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function startControlServer(
  port: number,
  handlers: ControlHandlers
): void {
  const server = createServer((req, res) => {
    void handleRequest(req, res, handlers)
  })

  server.on('error', (err) => {
    logger.error('TTS', `제어 서버 오류: ${err.message}`)
  })

  server.listen(port, '127.0.0.1', () => {
    logger.info('TTS', `제어 서버 준비 완료 (127.0.0.1:${port})`)
  })
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: ControlHandlers
): Promise<void> {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true, ...handlers.onHealth() })
      return
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    const body = (await readBody(req)) as Record<string, unknown>

    if (req.url === '/join') {
      if (
        !isNonEmptyString(body.guildId) ||
        !isNonEmptyString(body.voiceChannelId) ||
        !isNonEmptyString(body.textChannelId)
      ) {
        sendJson(res, 400, { error: 'missing fields' })
        return
      }
      await handlers.onJoin({
        guildId: body.guildId,
        textChannelId: body.textChannelId,
        voiceChannelId: body.voiceChannelId,
      })
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.url === '/leave') {
      if (!isNonEmptyString(body.guildId)) {
        sendJson(res, 400, { error: 'missing fields' })
        return
      }
      await handlers.onLeave({ guildId: body.guildId })
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.url === '/voice') {
      if (!isNonEmptyString(body.userId) || !isNonEmptyString(body.voiceId)) {
        sendJson(res, 400, { error: 'missing fields' })
        return
      }
      await handlers.onSetVoice({
        userId: body.userId,
        voiceId: body.voiceId,
      })
      sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : 'internal error',
    })
  }
}
