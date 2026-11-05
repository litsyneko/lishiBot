/**
 * AI 응답 중지 버튼 — UI와 customId 규칙을 한곳에 모은다.
 *
 * 설계 의사결정:
 * - customId 규칙은 승인 카드(aiApproval), 온보딩(aiOnboarding), 음악 패널(ctrl:)
 *   관례를 그대로 따른다. 접두사가 'aiStop'이라 다른 어떤 커스텀ID와도 겹치지
 *   않으므로 인터랙션 라우터에서 다른 핸들러와 충돌하지 않는다. parseStopCustomId가
 *   접두사가 다른 id에는 undefined를 돌려주는 것도 같은 관례다.
 * - turnId를 customId에 심는 이유: 버튼을 누른 시점에 "누가, 어느 대화의,
 *   어느 응답을" 멈춰야 하는지 알 수 있는 유일한 손잡이. 봇이 여러 턴을 동시에
 *   돌릴 수 있으므로 메시지 id만으로는 턴을 특정할 수 없다.
 * - 턴이 끝나면 중지 버튼 행을 **아예 제거한다**(아래 '왜 제거인가' 참고).
 */
import type { V2MessageComponent } from './thinkStripper'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js'

const STOP_CUSTOM_ID_PREFIX = 'aiStop'

/** Discord 컴포넌트 타입 값. 매직넘버 대신 이름을 붙여 '무엇인 행인가'를 드러낸다. */
const COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
} as const

export function buildStopCustomId(turnId: string): string {
  return `${STOP_CUSTOM_ID_PREFIX}:${turnId}`
}

export function parseStopCustomId(
  customId: string
): { turnId: string } | undefined {
  if (!customId.startsWith(`${STOP_CUSTOM_ID_PREFIX}:`)) {
    return undefined
  }
  const turnId = customId.slice(`${STOP_CUSTOM_ID_PREFIX}:`.length)
  return turnId.length > 0 ? { turnId } : undefined
}

function stopEmoji(): string {
  return '⏹️'
}

export function buildStopButton(turnId: string): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(buildStopCustomId(turnId))
    .setLabel('중지')
    .setEmoji(stopEmoji())
    .setStyle(ButtonStyle.Secondary)
}

type ComponentV2Payload = {
  components: V2MessageComponent[]
  flags: number
}

function stopRow(turnId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    buildStopButton(turnId)
  )
}

/**
 * toComponentV2가 만든 컴포넌트 끝에 중지 버튼 행을 붙인다.
 * Components V2에서 ActionRow는 TextDisplay 뒤에 와야 하므로 '맨 끝 추가'로
 * 순서를 보장한다. turnId는 버튼 customId에 들어가므로 호출부가 넘겨야 한다.
 */
export function attachStopButton(
  components: readonly V2MessageComponent[],
  turnId: string
): ComponentV2Payload {
  return {
    components: [...components, stopRow(turnId)],
    flags: MessageFlags.IsComponentsV2,
  }
}

/**
 * 이미 붙어 있는 중지 버튼 행을 통째로 제거한다.
 *
 * 왜 제거하는가(비활성 버튼을 남기는 안보다 나은 이유):
 * - 1. Discord은 disabled 여부와 무관하게 모든 button에 custom_id를 요구한다.
 *   실서버에서 확정 편집이 400(BUTTON_COMPONENT_CUSTOM_ID_REQUIRED)으로 죽었다.
 *   더미 customId를 심는 안은 버그를 피하지만, '없는 턴'을 가리키는 커스텀ID가
 *   실재하지 않는 상호작용을 만들어 라우터를 오염시킨다.
 * - 2. 이미 끝난 응답에 남아 있는 중지 버튼은 사용자가 눌러 볼 수 있는 살아 있는
 *   컨트롤이다. 제거하면 '더 이상 멈출 게 없다'가 화면 자체로 전달된다.
 *
 * 판정을 JSON 구조로 하는 이유: `instanceof ActionRowBuilder`는
 * '@discordjs/builders'와 'discord.js'가 서로 다른 클래스 복사본을 노출해
 * 크로스 패키지 판정이 false가 된다(실측: 두 클래스 객체는 서로 다르다). 지금은
 * 같은 파일이 만든 행만 지나가 우연히 동작하지만, 누가 다른 패키지에서 만든
 * ActionRow를 넘기면 조용히 걸러지지 않는다. type 필드는 안정적인 discriminator다.
 */
export function removeStopButton(
  components: readonly V2MessageComponent[]
): ComponentV2Payload {
  return {
    components: components.filter((component) => {
      // builder.type는 타입에 없고 data.type로 접근해야 한다. 숫자 1은
      // ActionRow, 10은 TextDisplay, 14는 Separator(Discord 컴포넌트 타입 값).
      if (component.data.type !== COMPONENT_TYPE.ACTION_ROW) {
        return true
      }
      const buttons = (component as ActionRowBuilder<ButtonBuilder>)
        .components as ButtonBuilder[]
      return !buttons.some(isStopButton)
    }),
    flags: MessageFlags.IsComponentsV2,
  }
}

/**
 * 버튼이 우리 것이 맞는지 본다. builder.data는 Partial<유니온>이라
 * custom_id 접근이 타입으로 열리지 않으므로, 우리가 심은 값 하나만 문자열로
 * 비교한다(다른 버튼에 custom_id가 없을 때 undefined가 된다).
 */
function isStopButton(button: ButtonBuilder): boolean {
  const customId: unknown = (button.data as { custom_id?: unknown }).custom_id
  return (
    typeof customId === 'string' &&
    customId.startsWith(`${STOP_CUSTOM_ID_PREFIX}:`)
  )
}

/**
 * 최종 편집 payload가 Discord 규약을 만족하는지 로컬에서 확인한다.
 *
 * 실서버가 알려준 전제: 이 검사는 디버깅용이다. 위에서 고친 400 버그
 * (BUTTON_COMPONENT_CUSTOM_ID_REQUIRED)는 toJSON()만으로는 로컬에서 걸러지지
 * 않았다. 그 이유는 toJSON()이 빠진 필드를 채워 넣지 않기 때문이다 — 실서버의
 * 검증을 통과해야만 나오는 오류라, 이 함수가 통과했다고 해서 실서버 400이
 * 반드시 사라졌다는 뜻은 아니다. 다만 'custom_id 누락'이라는 이 오류의 직접
 * 원인은 여기서 잡힌다.
 */
export function hasEveryButtonCustomId(
  components: readonly V2MessageComponent[]
): boolean {
  for (const component of components) {
    if (component.data.type !== COMPONENT_TYPE.ACTION_ROW) {
      continue
    }
    const buttons = (component as ActionRowBuilder<ButtonBuilder>)
      .components as ButtonBuilder[]
    for (const button of buttons) {
      if (button.data.type !== COMPONENT_TYPE.BUTTON) {
        continue
      }
      const customId: unknown = (button.data as { custom_id?: unknown })
        .custom_id
      if (typeof customId !== 'string' || customId.length === 0) {
        return false
      }
    }
  }
  return true
}
