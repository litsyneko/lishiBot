import {
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  MessageFlags,
} from 'discord.js'

export async function replyEphemeral(
  interaction: ChatInputCommandInteraction,
  content: string
): Promise<void> {
  const options: InteractionReplyOptions = {
    content,
    flags: MessageFlags.Ephemeral,
  }

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(options)
    return
  }

  await interaction.reply(options)
}

export async function replyPublic(
  interaction: ChatInputCommandInteraction,
  content: string
): Promise<void> {
  const options: InteractionReplyOptions = {
    content,
  }

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(options)
    return
  }

  await interaction.reply(options)
}
