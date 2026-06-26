import { Extension, SubCommandGroup, option } from '@pikokr/command.ts'
import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js'
import { getMemoryStore } from '../features/ai/memoryStore'

const memoryGroup = new SubCommandGroup({ name: 'memory', description: 'AI 메모리를 관리합니다' })

class MemoryExtension extends Extension {
  @memoryGroup.command({ name: 'list', description: '저장된 메모리를 확인합니다' })
  async list(i: ChatInputCommandInteraction) {
    const store = getMemoryStore()
    if (!store.isAvailable()) {
      await i.reply({
        content: 'Supabase가 설정되지 않아 메모리 기능을 사용할 수 없어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const memories = await store.list(i.user.id)
    if (memories.length === 0) {
      await i.reply({
        content: '저장된 메모리가 없어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const lines = memories.map(
      (m, idx) =>
        `**${idx + 1}.** ${m.content}\n> 저장: <t:${Math.floor(new Date(m.createdAt).getTime() / 1000)}:R>`,
    )
    await i.reply({
      content: `📝 AI가 기억하고 있는 내용이에요 (${memories.length}/15)\n\n${lines.join('\n')}`,
      flags: MessageFlags.Ephemeral,
    })
  }

  @memoryGroup.command({ name: 'delete', description: '특정 메모리를 삭제합니다' })
  async delete(
    i: ChatInputCommandInteraction,
    @option({
      type: ApplicationCommandOptionType.Integer,
      name: 'number',
      description: '삭제할 메모리 번호 (list 명령어로 확인)',
      required: true,
      min_value: 1,
    })
    number: number,
  ) {
    const store = getMemoryStore()
    if (!store.isAvailable()) {
      await i.reply({
        content: 'Supabase가 설정되지 않아 메모리 기능을 사용할 수 없어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const memories = await store.list(i.user.id)
    const target = memories[number - 1]
    if (target === undefined) {
      await i.reply({
        content: `❌ ${number}번 메모리가 없어요. /memory list로 번호를 확인해주세요.`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    await store.remove(i.user.id, target.id)
    await i.reply({
      content: `🗑️ "${target.content.slice(0, 50)}${target.content.length > 50 ? '...' : ''}" 메모리를 삭제했어요.`,
      flags: MessageFlags.Ephemeral,
    })
  }

  @memoryGroup.command({ name: 'clear', description: '모든 메모리를 초기화합니다' })
  async clear(i: ChatInputCommandInteraction) {
    const store = getMemoryStore()
    if (!store.isAvailable()) {
      await i.reply({
        content: 'Supabase가 설정되지 않아 메모리 기능을 사용할 수 없어요.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    await store.clear(i.user.id)
    await i.reply({
      content: '🗑️ 모든 메모리를 초기화했어요.',
      flags: MessageFlags.Ephemeral,
    })
  }
}

export const setup = async () => {
  return new MemoryExtension()
}
