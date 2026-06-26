import type { Client } from 'discord.js'
import type { ToolDefinition, ToolRegistry } from './toolTypes'
import {
  createChannelTool,
  deleteChannelTool,
  editChannelTool,
  listChannelsTool,
  lookupChannelTool,
  readChannelMessagesTool,
} from './tools/channelTools'
import { editThreadTool, readThreadMessagesTool } from './tools/threadTools'
import { listForumPostsTool, readForumPostTool } from './tools/forumTools'
import { getServerInfoTool } from './tools/serverTools'
import { lookupMemberTool } from './tools/memberTools'
import { listRolesTool, lookupRoleTool } from './tools/roleTools'
import {
  listCategoryChannelsTool,
  reorderCategoryChannelsTool,
  createCategoryTool,
  deleteCategoryTool,
} from './tools/categoryTools'
import { getStickerTool } from './tools/stickerTools'
import { sendStickerTool } from './tools/sendStickerTool'
import { sendMessageTool } from './tools/sendMessageTool'
import { saveMemoryTool } from './tools/memoryTool'
import {
  clearQueueTool,
  getMusicStateTool,
  pauseMusicTool,
  playMusicTool,
  removeFromQueueTool,
  resumeMusicTool,
  seekMusicTool,
  setVolumeTool,
  shuffleQueueTool,
  skipTrackTool,
  stopMusicTool,
  searchMusicTool,
} from './tools/musicTool'

export function createToolRegistry(client: Client): ToolRegistry {
  const tools = new Map<string, ToolDefinition>()

  function register(def: ToolDefinition) {
    tools.set(def.declaration.name, def)
  }

  register(createChannelTool(client))
  register(deleteChannelTool(client))
  register(editChannelTool(client))
  register(editThreadTool(client))
  register(listChannelsTool(client))
  register(lookupChannelTool(client))
  register(readChannelMessagesTool(client))
  register(readThreadMessagesTool(client))
  register(listForumPostsTool(client))
  register(readForumPostTool(client))
  register(getServerInfoTool(client))
  register(lookupMemberTool(client))
  register(listRolesTool(client))
  register(lookupRoleTool(client))
  register(listCategoryChannelsTool(client))
  register(reorderCategoryChannelsTool(client))
  register(createCategoryTool(client))
  register(deleteCategoryTool(client))
  register(getStickerTool(client))
  register(sendStickerTool(client))
  register(sendMessageTool(client))
  register(saveMemoryTool)
  register(playMusicTool(client))
  register(stopMusicTool(client))
  register(pauseMusicTool(client))
  register(resumeMusicTool(client))
  register(setVolumeTool(client))
  register(shuffleQueueTool(client))
  register(seekMusicTool(client))
  register(skipTrackTool(client))
  register(removeFromQueueTool(client))
  register(clearQueueTool(client))
  register(getMusicStateTool(client))
  register(searchMusicTool(client))

  return {
    get: (name: string) => tools.get(name),
    getAll: () => [...tools.values()],
    register,
    toFunctionDeclarations: () =>
      [...tools.values()].map((t) => t.declaration),
  }
}
