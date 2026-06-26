import type { Client, Guild } from 'discord.js'
import type { ToolExecutionContext } from '../toolTypes'

export async function resolveGuild(client: Client, context: ToolExecutionContext): Promise<Guild> {
  const cached = client.guilds.cache.get(context.guildId)
  if (cached !== undefined) {
    return cached
  }

  const fetched = await client.guilds.fetch(context.guildId).catch(() => undefined)
  if (fetched !== undefined) {
    return fetched
  }

  throw new Error('서버를 찾을 수 없어요.')
}
