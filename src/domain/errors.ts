export class CommandAccessError extends Error {
  public constructor(public readonly messageForUser: string) {
    super(messageForUser)
    this.name = 'CommandAccessError'
  }
}
