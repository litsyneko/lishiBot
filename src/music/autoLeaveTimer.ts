export type AutoLeaveDeps = {
  readonly cancel: (id: ReturnType<typeof setTimeout>) => void
  readonly delayMs: number
  readonly leaveGuild: (guildId: string) => void
  readonly schedule: (
    delayMs: number,
    fire: () => void
  ) => ReturnType<typeof setTimeout>
}

export type AutoLeaveScheduler = {
  readonly cancelLeave: (guildId: string) => void
  readonly scheduleLeave: (guildId: string) => void
}

export function createAutoLeaveScheduler(
  deps: AutoLeaveDeps
): AutoLeaveScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  return {
    cancelLeave: (guildId) => {
      const timerId = timers.get(guildId)
      if (timerId !== undefined) {
        deps.cancel(timerId)
        timers.delete(guildId)
      }
    },
    scheduleLeave: (guildId) => {
      const existing = timers.get(guildId)
      if (existing !== undefined) {
        deps.cancel(existing)
      }

      const timerId = deps.schedule(deps.delayMs, () => {
        timers.delete(guildId)
        deps.leaveGuild(guildId)
      })
      timers.set(guildId, timerId)
    },
  }
}
