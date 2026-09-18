type LavalinkConfig = {
  host: string
  port: number
  password: string
  secure: boolean
}

export type AiProviderType = 'openai-compatible' | 'anthropic'

// 생각(추론) 노력. openai-compatible 전용. 미지정 시 엔드포인트 기본값(medium).
// minimal은 OpenAI 계열만, low/medium/high는 OpenRouter 등 대부분의 추론 모델이 받는다.
export type AiReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'

// primary 또는 fallbacks 배열의 한 항목. provider 종류에 따라 필수 필드가 다르다:
// - anthropic: apiKey, model
// - openai-compatible: apiKey, model (+ baseUrl. 미지정 시 OpenCode Zen 기본)
export type AiProviderConfig = {
  provider: AiProviderType
  apiKey?: string
  model: string
  // openai-compatible 전용: OpenAI-호환 엔드포인트. 미지정 시 OpenCode Zen 기본.
  baseUrl?: string
  // 로그 표기용 이름 (미지정 시 provider 종류로 표기).
  label?: string
  // openai-compatible 전용: 생각(추론) 노력. 미지정 시 엔드포인트 기본값.
  reasoningEffort?: AiReasoningEffort
}

export type AiConfig = {
  // 첫 번째 provider. 없으면 AI 비활성(dry-run).
  primary?: AiProviderConfig
  // primary 실패 시 배열 순서대로 시도하고, 전부 실패해야 dry-run.
  fallbacks?: AiProviderConfig[]
  // 전역 컨텍스트 예산(토큰). 미지정 시 엔드포인트로 자동 감지:
  // 클라우드 1,048,576(1m) / 로컬(localhost·사설 IP) 131,072(128k).
  // 이 예산 안에 시스템 프롬프트·대화 히스토리·응답이 들어가도록
  // 요청마다 히스토리를 최신 우선으로 잘라 넣는다.
  contextTokens?: number
}

type SupabaseConfig = {
  url: string
  secretKey: string
}

// 별도 프로세스로 도는 TTS 봇(두 번째 토큰) 설정.
type TtsBotConfig = {
  token: string
  clientId?: string
  // 메인봇 ↔ TTS봇 로컬 제어용 HTTP 포트 (기본 8787)
  port?: number
  // 메인봇이 TTS봇에 접속할 주소 (기본 http://127.0.0.1:<port>)
  controlUrl?: string
}

type ElevenLabsConfig = {
  apiKey: string
  voiceId: string
  // 한국어는 'eleven_multilingual_v2' 권장
  modelId?: string
  // v3 전용: 0.0(Creative, 태그 반응 최대) | 0.5(Natural) | 1.0(Robust)
  stability?: number
}

type Config = {
  token: string
  guilds: string[]
  clientId: string
  lavalink: LavalinkConfig
  ai: AiConfig
  supabase?: SupabaseConfig
  tts?: TtsBotConfig
  elevenLabs?: ElevenLabsConfig
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
export const config: Config = require('../config.json')
