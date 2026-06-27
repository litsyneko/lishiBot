import { CommandAccessError } from '../domain/errors'
import {
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js'

export function requireGuildInteraction(
  interaction: ChatInputCommandInteraction
): void {
  if (interaction.guild === null) {
    throw new CommandAccessError(
      '이 명령어는 Discord 서버 안에서만 사용할 수 있어요.'
    )
  }
}

export function requireServerManager(
  interaction: ChatInputCommandInteraction
): void {
  requireGuildInteraction(interaction)

  const permissions = interaction.memberPermissions
  if (permissions === null) {
    throw new CommandAccessError(
      '권한 정보를 확인할 수 없어 작업을 중단했어요.'
    )
  }

  const canManage =
    permissions.has(PermissionFlagsBits.Administrator) ||
    permissions.has(PermissionFlagsBits.ManageGuild)

  if (!canManage) {
    throw new CommandAccessError(
      '서버 관리 권한이 있는 사용자만 실행할 수 있어요.'
    )
  }
}
