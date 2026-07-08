import { logger } from '../../utils/logger'
import {
  type ApplicationCommandOption,
  ApplicationCommandOptionType,
  type Guild,
} from 'discord.js'

// 리시(AI)가 봇의 슬래시 명령어 구조를 알 수 있도록, 길드에 실제로
// 등록된 명령어 목록에서 안내문을 자동 생성한다. 하드코딩 목록은
// 명령이 바뀔 때마다 낡으므로 두지 않는다.
// 명령어는 배포(재시작) 시에만 바뀌므로 프로세스 수명 동안 캐시한다.

const catalogCache = new Map<string, string>()

export async function getCommandCatalog(guild: Guild | null): Promise<string> {
  if (guild === null) return ''

  const cached = catalogCache.get(guild.id)
  if (cached !== undefined) return cached

  try {
    const commands = await guild.commands.fetch()
    const lines: string[] = []

    // reload는 오너 전용 개발 명령이라 사용자 안내 대상이 아니다.
    const sorted = Array.from(commands.values())
      .filter((command) => command.name !== 'reload')
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'))

    for (const command of sorted) {
      const subLines = flattenSubcommands(command.name, command.options ?? [])
      if (subLines.length > 0) {
        lines.push(...subLines)
      } else {
        lines.push(`- \`/${command.name}\` — ${command.description}`)
      }
    }

    if (lines.length === 0) return ''

    const catalog = [
      '## 봇 슬래시 명령어 (전체 목록)',
      '사용자가 기능이나 사용법을 물으면 아래 명령어로 안내하세요.',
      '- 이 목록에 없는 명령어·옵션을 지어내지 마세요. 목록이 봇의 전부예요.',
      '- 설명에 "관리자:"가 붙었거나 `/서버` 그룹인 명령은 서버 관리 권한이 필요해요. 일반 유저에게는 권한이 필요하다고 함께 안내하세요.',
      '- 명령어는 반드시 `` `/명령 하위명령` `` 인라인 코드 형식으로 표기하세요.',
      ...lines,
    ].join('\n')

    catalogCache.set(guild.id, catalog)
    return catalog
  } catch (err) {
    logger.warn(
      'AI',
      `명령어 카탈로그 생성 실패: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return ''
  }
}

function flattenSubcommands(
  commandName: string,
  options: readonly ApplicationCommandOption[]
): string[] {
  const lines: string[] = []

  for (const option of options) {
    if (option.type === ApplicationCommandOptionType.Subcommand) {
      lines.push(`- \`/${commandName} ${option.name}\` — ${option.description}`)
    } else if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
      for (const sub of option.options ?? []) {
        lines.push(
          `- \`/${commandName} ${option.name} ${sub.name}\` — ${sub.description}`
        )
      }
    }
  }

  return lines
}
