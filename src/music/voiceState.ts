export type ChannelMember = {
  readonly id: string
  readonly isBot: boolean
}

export type VoiceChannelSnapshot = {
  readonly botId: string
  readonly members: readonly ChannelMember[]
}

export function isBotAlone(snapshot: VoiceChannelSnapshot): boolean {
  const humans = countHumansInChannel(snapshot)
  return (
    humans === 0 &&
    snapshot.members.some((member) => member.id === snapshot.botId)
  )
}

export function countHumansInChannel(snapshot: VoiceChannelSnapshot): number {
  return snapshot.members.filter((member) => !member.isBot).length
}

export function shouldAutoLeave(snapshot: VoiceChannelSnapshot): boolean {
  if (snapshot.members.length === 0) {
    return false
  }

  return isBotAlone(snapshot)
}
