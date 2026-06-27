import { config } from '../config'
import { loadSoundboardGuardSettings } from '../features/soundboard/soundboardGuardStore'
import { logger } from '../utils/logger'
import { Extension, applicationCommand, listener } from '@pikokr/command.ts'
import { Routes } from 'discord-api-types/v10'
import {
  ApplicationCommandType,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js'

class HelloExtension extends Extension {
  @listener({ event: 'clientReady' })
  async ready() {
    this.logger.info(`Logged in as ${this.client.user?.tag}`)
    await this.commandClient.fetchOwners()

    await loadSoundboardGuardSettings()

    try {
      const user = this.client.user
      if (user === null) {
        logger.warn(
          'Command',
          'client.user가 없어 명령어 권한 설정을 건너뛰어요.'
        )
        return
      }
      const rest = this.client.rest
      const commands = (await rest.get(
        Routes.applicationGuildCommands(user.id, config.guilds[0])
      )) as Array<{ id: string; name: string }>

      const serverCommand = commands.find((c) => c.name === '서버')
      if (serverCommand !== undefined) {
        await rest.patch(
          Routes.applicationGuildCommand(
            user.id,
            config.guilds[0],
            serverCommand.id
          ),
          {
            body: {
              default_member_permissions: String(
                PermissionFlagsBits.ManageGuild |
                  PermissionFlagsBits.Administrator
              ),
            },
          }
        )
        logger.info(
          'Command',
          '/서버 명령어 권한을 서버 관리 이상으로 제한했어요.'
        )
      }
    } catch (err) {
      logger.error(
        'Command',
        `명령어 권한 설정 실패: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  @listener({ event: 'applicationCommandInvokeError', emitter: 'cts' })
  async errorHandler(err: Error) {
    logger.error('Command', err.message)
  }

  @applicationCommand({
    name: 'ping',
    type: ApplicationCommandType.ChatInput,
    description: 'wow this is ping',
  })
  async ping(i: ChatInputCommandInteraction) {
    await i.reply(`current ping: ${i.client.ws.ping}ms`)
  }
}

export const setup = async () => {
  return new HelloExtension()
}
