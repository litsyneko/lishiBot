import { Player } from 'lavalink-client'

export type ControllerTab = 'playback' | 'settings'

const CONTROLLER_MESSAGE_ID_KEY = 'controllerMessageId'
const CONTROLLER_CHANNEL_ID_KEY = 'controllerChannelId'
const CONTROLLER_TAB_KEY = 'controllerTab'
const QUEUE_VISIBLE_KEY = 'queueVisible'
const CONTROLLER_PAGE_KEY = 'controllerQueuePage'

export class CustomPlayer extends Player {
  get controllerMessageId(): string | undefined {
    const id = this.getData<string>(CONTROLLER_MESSAGE_ID_KEY)
    return typeof id === 'string' && id.length > 0 ? id : undefined
  }

  set controllerMessageId(value: string | undefined) {
    if (value === undefined) {
      this.deleteData(CONTROLLER_MESSAGE_ID_KEY)
    } else {
      this.setData(CONTROLLER_MESSAGE_ID_KEY, value)
    }
  }

  get controllerChannelId(): string | undefined {
    const id = this.getData<string>(CONTROLLER_CHANNEL_ID_KEY)
    return typeof id === 'string' && id.length > 0 ? id : undefined
  }

  set controllerChannelId(value: string | undefined) {
    if (value === undefined) {
      this.deleteData(CONTROLLER_CHANNEL_ID_KEY)
    } else {
      this.setData(CONTROLLER_CHANNEL_ID_KEY, value)
    }
  }

  get controllerTab(): ControllerTab {
    const tab = this.getData<string>(CONTROLLER_TAB_KEY)
    return tab === 'settings' ? 'settings' : 'playback'
  }

  set controllerTab(value: ControllerTab) {
    this.setData(CONTROLLER_TAB_KEY, value)
  }

  get queueVisible(): boolean {
    return this.getData<boolean>(QUEUE_VISIBLE_KEY) === true
  }

  set queueVisible(value: boolean) {
    if (value) {
      this.setData(QUEUE_VISIBLE_KEY, true)
    } else {
      this.deleteData(QUEUE_VISIBLE_KEY)
    }
  }

  get controllerPage(): number {
    const p = this.getData<number>(CONTROLLER_PAGE_KEY)
    return typeof p === 'number' && p > 0 ? p : 1
  }

  set controllerPage(value: number) {
    this.setData(CONTROLLER_PAGE_KEY, value)
  }
}
