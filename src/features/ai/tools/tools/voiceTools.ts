import { Client, type VoiceBasedChannel } from 'discord.js'
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../toolTypes'
import { resolveGuild } from '../helpers/resolveGuild'

type VoiceAction = 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'move' | 'disconnect'

export function voiceMemberLookupTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'voice_member_lookup',
      description:
        '음성 채널에 있는 사용자와 봇 목록을 조회합니다. 특정 음성 채널을 지정하거나, 전체 음성 채널의 멤버를 확인할 수 있어요.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: '조회할 음성 채널 ID (비우면 전체 음성 채널)',
          },
        },
        required: [],
      },
    },
    permission: {
      requireManageGuild: false,
      requireAdmin: false,
      risk: 'info',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      try {
        const guild = await resolveGuild(client, context)
        const channelId = (args.channel_id as string | undefined)?.trim()

        const voiceChannels = [...guild.channels.cache.values()].filter(
          (c): c is VoiceBasedChannel => c.isVoiceBased(),
        )

        const targetChannels = channelId
          ? voiceChannels.filter((c) => c.id === channelId)
          : voiceChannels

        if (targetChannels.length === 0) {
          return { success: false, message: '음성 채널을 찾을 수 없어요.' }
        }

        const results: Array<{
          channelName: string
          channelId: string
          members: Array<{
            id: string
            name: string
            isBot: boolean
            muted: boolean
            deafened: boolean
            streaming: boolean
          }>
        }> = []

        for (const ch of targetChannels) {
          const members = [...ch.members.values()].map((m) => ({
            id: m.id,
            name: m.displayName,
            isBot: m.user.bot,
            muted: m.voice.mute ?? false,
            deafened: m.voice.deaf ?? false,
            streaming: m.voice.streaming ?? false,
          }))

          if (members.length > 0) {
            results.push({
              channelName: ch.name,
              channelId: ch.id,
              members,
            })
          }
        }

        if (results.length === 0) {
          return {
            success: true,
            message: '음성 채널에 아무도 없어요.',
            summary: '음성 채널 멤버 없음',
          }
        }

        const totalMembers = results.reduce((sum, r) => sum + r.members.length, 0)
        const summaryLines = results.flatMap((r) =>
          r.members.map((m) => `- ${m.name}${m.isBot ? ' (봇)' : ''} @ ${r.channelName}${m.muted ? ' [음소거]' : ''}${m.streaming ? ' [방송중]' : ''}`),
        )
        const summary = `음성 채널 ${results.length}개, ${totalMembers}명:\n${summaryLines.join('\n')}`

        return {
          success: true,
          message: summary,
          summary,
          data: { channels: results, totalMembers },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, message: `음성 멤버 조회 중 오류가 발생했어요: ${message}` }
      }
    },
  }
}

export function voiceActionTool(client: Client): ToolDefinition {
  return {
    declaration: {
      name: 'voice_action',
      description:
        '음성 채널에 있는 멤버에게 음성 액션을 적용합니다. 서버 음소거(mute), 서버 음소거 해제(unmute), 청취 차단(deafen), 청취 차단 해제(undeafen), 채널 이동(move), 연결 해제(disconnect) 중 하나를 선택하세요.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: '수행할 액션',
            enum: ['mute', 'unmute', 'deafen', 'undeafen', 'move', 'disconnect'],
          },
          member_id: {
            type: 'string',
            description: '대상 멤버 ID',
          },
          target_channel_id: {
            type: 'string',
            description: '이동할 음성 채널 ID (action이 move일 때만 필요)',
          },
        },
        required: ['action', 'member_id'],
      },
    },
    permission: {
      requireManageGuild: true,
      requireAdmin: false,
      risk: 'warning',
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      try {
        const action = args.action as VoiceAction | undefined
        const memberId = (args.member_id as string | undefined)?.trim()

        if (!action || !memberId) {
          return { success: false, message: 'action과 member_id를 입력해 주세요.' }
        }

        const guild = await resolveGuild(client, context)

        const member = await guild.members.fetch(memberId).catch(() => undefined)
        if (member === undefined) {
          return { success: false, message: '멤버를 찾을 수 없어요.' }
        }

        if (!member.voice.channel) {
          return { success: false, message: `${member.displayName} 님은 음성 채널에 없어요.` }
        }

        const me = guild.members.me
        if (me !== null) {
          if (guild.ownerId === member.id) {
            return { success: false, message: '서버 주인에게는 이 작업을 할 수 없어요.' }
          }
          if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
            return { success: false, message: '리시보다 권한이 높거나 같은 멤버에게는 작업할 수 없어요.' }
          }
        }

        const actionLabels: Record<VoiceAction, string> = {
          mute: '서버 음소거',
          unmute: '서버 음소거 해제',
          deafen: '청취 차단',
          undeafen: '청취 차단 해제',
          move: '채널 이동',
          disconnect: '연결 해제',
        }

        switch (action) {
          case 'mute':
            await member.voice.setMute(true, 'AI 리시가 적용')
            break
          case 'unmute':
            await member.voice.setMute(false, 'AI 리시가 적용')
            break
          case 'deafen':
            await member.voice.setDeaf(true, 'AI 리시가 적용')
            break
          case 'undeafen':
            await member.voice.setDeaf(false, 'AI 리시가 적용')
            break
          case 'move': {
            const targetChannelId = (args.target_channel_id as string | undefined)?.trim()
            if (!targetChannelId) {
              return { success: false, message: '이동할 채널 ID(target_channel_id)를 입력해 주세요.' }
            }
            const targetChannel = guild.channels.cache.get(targetChannelId)
            if (targetChannel === undefined || !targetChannel.isVoiceBased()) {
              return { success: false, message: '유효한 음성 채널 ID를 입력해 주세요.' }
            }
            await member.voice.setChannel(targetChannelId, 'AI 리시가 적용')
            break
          }
          case 'disconnect':
            await member.voice.disconnect('AI 리시가 적용')
            break
        }

        const summary = `${member.displayName} 님에게 ${actionLabels[action]}를 적용했어요.`
        return {
          success: true,
          message: summary,
          summary,
          data: { memberId: member.id, action },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, message: `음성 액션 중 오류가 발생했어요: ${message}` }
      }
    },
  }
}
