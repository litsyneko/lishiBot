type LavalinkConfig = {
  host: string
  port: number
  password: string
  secure: boolean
}

type AiConfig = {
  provider: 'disabled' | 'opencode-zen'
  geminiApiKey?: string
  apiKey?: string
  model: string
}

type SupabaseConfig = {
  url: string
  secretKey: string
}

type Config = {
  token: string
  guilds: string[]
  clientId: string
  lavalink: LavalinkConfig
  ai: AiConfig
  supabase?: SupabaseConfig
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
export const config: Config = require('../config.json')
