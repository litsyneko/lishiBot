import { logger } from '../utils/logger'
import { Extension, listener } from '@pikokr/command.ts'
import {
  Events,
  type Guild,
  type GuildMember,
  type PartialUser,
  type User,
} from 'discord.js'

const TARGET_GUILD_ID = '1440598081648328816'
const TARGET_ROLE_ID = '1519487707607203942'

type TagChangeResult = 'added' | 'removed' | 'nochange'

function detectTagChange(
  oldUser: User | PartialUser,
  newUser: User
): TagChangeResult {
  const oldGuildId = oldUser.primaryGuild?.identityGuildId ?? null
  const oldEnabled = oldUser.primaryGuild?.identityEnabled ?? false
  const oldHasTag = oldGuildId === TARGET_GUILD_ID && oldEnabled

  const newGuildId = newUser.primaryGuild?.identityGuildId ?? null
  const newEnabled = newUser.primaryGuild?.identityEnabled ?? false
  const newHasTag = newGuildId === TARGET_GUILD_ID && newEnabled

  if (newHasTag && !oldHasTag) return 'added'
  if (!newHasTag && oldHasTag) return 'removed'
  return 'nochange'
}

async function applyRoleToAllTargetGuilds(
  client: import('discord.js').Client,
  userId: string,
  action: 'add' | 'remove'
): Promise<readonly { guild: Guild; success: boolean }[]> {
  const results: { guild: Guild; success: boolean }[] = []

  for (const guild of client.guilds.cache.values()) {
    if (guild.id !== TARGET_GUILD_ID) continue

    const member = await guild.members.fetch(userId).catch(() => undefined)
    if (member === undefined) continue

    try {
      if (action === 'add') {
        if (!member.roles.cache.has(TARGET_ROLE_ID)) {
          await member.roles.add(TARGET_ROLE_ID, '서버 태그 적용 감지')
        }
      } else {
        if (member.roles.cache.has(TARGET_ROLE_ID)) {
          await member.roles.remove(TARGET_ROLE_ID, '서버 태그 해제 감지')
        }
      }
      results.push({ guild, success: true })
    } catch (err) {
      logger.error(
        'ClanTag',
        `역할 ${action === 'add' ? '부여' : '제거'} 실패 (${guild.name}): ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      results.push({ guild, success: false })
    }
  }

  return results
}

export type ClanTagLogEntry = {
  readonly action: 'added' | 'removed'
  readonly member: GuildMember
  readonly oldTag: string | null
  readonly newTag: string | null
}

class ClanTagExtensionClass extends Extension {
  @listener({ event: Events.UserUpdate })
  async onUserUpdate(
    oldUser: User | PartialUser,
    newUser: User
  ): Promise<void> {
    if (newUser.bot) return

    const change = detectTagChange(oldUser, newUser)
    if (change === 'nochange') return

    const action = change === 'added' ? 'add' : 'remove'
    const results = await applyRoleToAllTargetGuilds(
      this.client,
      newUser.id,
      action
    )

    for (const result of results) {
      if (!result.success) continue
      const member = await result.guild.members
        .fetch(newUser.id)
        .catch(() => undefined)
      if (member === undefined) continue

      this.emitTagChange({
        action: change,
        member,
        oldTag: oldUser.primaryGuild?.tag ?? null,
        newTag: newUser.primaryGuild?.tag ?? null,
      })
    }

    logger.info(
      'ClanTag',
      `${newUser.tag}: 서버 태그 ${
        change === 'added' ? '적용' : '해제'
      } → 역할 ${action === 'add' ? '부여' : '제거'}`
    )
  }

  private emitTagChange(entry: ClanTagLogEntry): void {
    this.client.emit('clanTagChange' as string, entry)
  }
}

export const setup = () => {
  return new ClanTagExtensionClass()
}
