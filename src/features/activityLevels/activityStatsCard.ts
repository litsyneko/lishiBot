import {
  type GuildStatsCardInput,
  renderGuildStatsCard,
} from './activityStatsCardGuild'
import {
  type PersonalStatsCardInput,
  renderPersonalStatsCard,
} from './activityStatsCardPersonal'
import { ensureActivityLevelCardFontsRegistered } from './activityStatsCardTheme'

export type ActivityStatsCardInput =
  | (PersonalStatsCardInput & { readonly scope: 'personal' })
  | (GuildStatsCardInput & { readonly scope: 'guild' })

export async function renderActivityStatsCard(
  input: ActivityStatsCardInput
): Promise<Buffer> {
  ensureActivityLevelCardFontsRegistered()

  switch (input.scope) {
    case 'personal':
      return renderPersonalStatsCard({
        username: input.username,
        avatarUrl: input.avatarUrl,
        type: input.type,
        result: input.result,
      })
    case 'guild':
      return renderGuildStatsCard({
        guildName: input.guildName,
        guildIconUrl: input.guildIconUrl,
        type: input.type,
        result: input.result,
        displayNames: input.displayNames,
      })
  }
}
