import type { ToolDefinition, ToolRegistry } from './toolTypes'
import {
  createCategoryTool,
  deleteCategoryTool,
  listCategoryChannelsTool,
  reorderCategoryChannelsTool,
} from './tools/categoryTools'
import {
  createChannelTool,
  deleteChannelTool,
  editChannelTool,
  listChannelsTool,
  lookupChannelTool,
  readChannelMessagesTool,
} from './tools/channelTools'
import { listForumPostsTool, readForumPostTool } from './tools/forumTools'
import {
  banMemberTool,
  kickMemberTool,
  removeTimeoutMemberTool,
  timeoutMemberTool,
  unbanMemberTool,
} from './tools/memberActionTools'
import { lookupMemberTool } from './tools/memberTools'
import { saveMemoryTool } from './tools/memoryTool'
import {
  clearQueueTool,
  getMusicStateTool,
  pauseMusicTool,
  playMusicTool,
  removeFromQueueTool,
  resumeMusicTool,
  searchMusicTool,
  seekMusicTool,
  setVolumeTool,
  shuffleQueueTool,
  skipTrackTool,
  stopMusicTool,
} from './tools/musicTool'
import { listRolesTool, lookupRoleTool } from './tools/roleTools'
import { sendMessageTool } from './tools/sendMessageTool'
import { sendStickerTool } from './tools/sendStickerTool'
import { getServerInfoTool } from './tools/serverTools'
import { getStickerTool } from './tools/stickerTools'
import { editThreadTool, readThreadMessagesTool } from './tools/threadTools'
import { voiceActionTool, voiceMemberLookupTool } from './tools/voiceTools'
import type { Client } from 'discord.js'

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
  register(voiceMemberLookupTool(client))
  register(voiceActionTool(client))
  register(timeoutMemberTool(client))
  register(removeTimeoutMemberTool(client))
  register(banMemberTool(client))
  register(unbanMemberTool(client))
  register(kickMemberTool(client))
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
    toFunctionDeclarations: () => [...tools.values()].map((t) => t.declaration),
  }
}
