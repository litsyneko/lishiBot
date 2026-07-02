import { config } from '../config'
import { MODERATION_GUILD_ID } from '../features/moderation/moderationConfig'
import { loadSoundboardGuardSettings } from '../features/soundboard/soundboardGuardStore'
import { logger } from '../utils/logger'
import { getMusicManager } from './MusicExtension'
import { Extension, applicationCommand, listener } from '@pikokr/command.ts'
import { Routes } from 'discord-api-types/v10'
import {
  ActivityType,
  ApplicationCommandType,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js'

const PRESENCE_INTERVAL_MS = 30_000
const MAX_TRACK_TITLE_LENGTH = 64
const MAX_UPLOADER_LENGTH = 32
const PLAYING_EMOJI = '<a:Lishi_07:1521143128025731263>'

function truncateTitle(title: string): string {
  if (title.length <= MAX_TRACK_TITLE_LENGTH) return title
  return title.slice(0, MAX_TRACK_TITLE_LENGTH - 1) + '…'
}

function truncateUploader(uploader: string): string {
  if (uploader.length <= MAX_UPLOADER_LENGTH) return uploader
  return uploader.slice(0, MAX_UPLOADER_LENGTH - 1) + '…'
}

class HelloExtension extends Extension {
  private presenceTimer: NodeJS.Timeout | undefined

  @listener({ event: 'clientReady' })
  async ready() {
    this.logger.info(`Logged in as ${this.client.user?.tag}`)
    await this.commandClient.fetchOwners()

    await loadSoundboardGuardSettings()

    this.startPresenceLoop()

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

  private startPresenceLoop(): void {
    void this.updatePresence()
    this.presenceTimer = setInterval(
      () => void this.updatePresence(),
      PRESENCE_INTERVAL_MS
    )
  }

  private updatePresence(): void {
    const user = this.client.user
    if (user === null) return

    let playingTrack: string | null = null
    let playingUploader: string | null = null
    try {
      const manager = getMusicManager()
      const player = manager.players.get(MODERATION_GUILD_ID)
      if (
        player !== undefined &&
        player.playing &&
        player.queue.current?.info?.title !== undefined
      ) {
        playingTrack = player.queue.current.info.title
        playingUploader = player.queue.current.info.author ?? null
      }
    } catch {
      void 0
    }

    if (playingTrack !== null) {
      const title = truncateTitle(playingTrack)
      const uploader =
        playingUploader !== null ? truncateUploader(playingUploader) : ''
      const statusText =
        uploader.length > 0
          ? `${PLAYING_EMOJI} 재생 중: ${title} - ${uploader}`
          : `${PLAYING_EMOJI} 재생 중: ${title}`
      user.setActivity(statusText, {
        type: ActivityType.Listening,
      })
    } else {
      user.setActivity('멘션으로 대화하세요', {
        type: ActivityType.Playing,
      })
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
