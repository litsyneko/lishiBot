const DEFAULT_VOLUME = 100

const volumes = new Map<string, number>()
const preMuteVolumes = new Map<string, number>()

export function getVolume(guildId: string): number {
  return volumes.get(guildId) ?? DEFAULT_VOLUME
}

export function setVolume(guildId: string, volume: number): void {
  volumes.set(guildId, volume)
}

export function mute(guildId: string): void {
  const current = getVolume(guildId)
  if (current > 0) {
    preMuteVolumes.set(guildId, current)
    setVolume(guildId, 0)
  }
}

export function unmute(guildId: string): number {
  const saved = preMuteVolumes.get(guildId)
  const target = saved !== undefined && saved > 0 ? saved : DEFAULT_VOLUME
  preMuteVolumes.delete(guildId)
  setVolume(guildId, target)
  return target
}
