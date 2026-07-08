import { SeparatorBuilder, TextDisplayBuilder } from '@discordjs/builders'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SeparatorSpacingSize,
} from 'discord.js'

// ── customId 체계 ──

const ONBOARDING_PREFIX = 'aiOnboarding'

export type OnboardingAction =
  | 'start'
  | 'dismiss2h'
  | 'dismiss24h'
  | 'dismissChat'

export function buildOnboardingCustomId(
  action: OnboardingAction,
  guildId: string
): string {
  return `${ONBOARDING_PREFIX}:${action}:${guildId}`
}

export function parseOnboardingCustomId(
  customId: string
): { action: OnboardingAction; guildId: string } | undefined {
  if (!customId.startsWith(`${ONBOARDING_PREFIX}:`)) return undefined
  const [, action, guildId] = customId.split(':')
  const validActions: OnboardingAction[] = [
    'start',
    'dismiss2h',
    'dismiss24h',
    'dismissChat',
  ]
  if (!validActions.includes(action as OnboardingAction)) return undefined
  if (guildId === undefined || guildId.length === 0) return undefined
  return { action: action as OnboardingAction, guildId }
}

// ── 온보딩 안내 카드 (Components V2) ──

export function buildOnboardingCard(guildId: string): {
  components: (
    | TextDisplayBuilder
    | SeparatorBuilder
    | ActionRowBuilder<ButtonBuilder>
  )[]
  flags: number
} {
  const body = [
    '🌙 **FullMoon 에이전트 온보딩**',
    '',
    '안녕하세요! 이 서버에서 처음 만났네요.',
    '저는 서버 관리를 도와주는 AI 에이전트예요. 몇 가지 설정을 해두면 더 잘 도와드릴 수 있어요.',
    '',
    '**지금 설정 가능한 것들:**',
    '• 서버 컨셉 — 이 서버가 어떤 곳인지 알려주세요',
    '• 채널 용도 — 각 채널이 어떤 용도인지 (예: 잡담, 공지, 조용한 채널)',
    '• 승인 정책 — 위험한 작업(채널 삭제, 밴 등)의 승인 방식',
    '',
    '-# 설정 없이도 사용 가능해요! 위험 작업은 기본적으로 관리자 승인이 필요해요.',
  ].join('\n')

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildOnboardingCustomId('start', guildId))
      .setLabel('온보딩 완료')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(buildOnboardingCustomId('dismiss2h', guildId))
      .setLabel('2시간 뒤에')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildOnboardingCustomId('dismiss24h', guildId))
      .setLabel('오늘은 안 볼래요')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildOnboardingCustomId('dismissChat', guildId))
      .setLabel('닫기')
      .setStyle(ButtonStyle.Secondary)
  )

  return {
    components: [
      new TextDisplayBuilder().setContent(body),
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
      new TextDisplayBuilder().setContent(
        '-# `/에이전트 설정` 명령어로 나중에 언제든 설정할 수 있어요.'
      ),
      buttons,
    ],
    flags: MessageFlags.IsComponentsV2,
  }
}

// ── 결과 카드 (버튼 제거 후 치환) ──

export function buildOnboardingResolvedCard(statusLine: string): {
  components: (TextDisplayBuilder | SeparatorBuilder)[]
  flags: number
} {
  return {
    components: [
      new TextDisplayBuilder().setContent('🌙 **FullMoon 에이전트 온보딩**'),
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
      new TextDisplayBuilder().setContent(statusLine),
    ],
    flags: MessageFlags.IsComponentsV2,
  }
}
