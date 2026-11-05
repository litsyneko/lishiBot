// 사용자가 선택할 수 있는 로컬 VOICEVOX TTS 목소리 목록.
// 메인봇(/tts 목소리 명령 choices)과 TTS봇(검증·해석)이 공유한다.

export type TtsVoiceOption = {
  readonly id: string
  readonly label: string
  readonly description?: string
}

export const TTS_VOICES: readonly TtsVoiceOption[] = [
  {
    id: '3',
    label: '즈ンダ몬 (기본/노말)',
    description: '귀엽고 발랄한 마스코트 보이스',
  },
  {
    id: '1',
    label: '즈ンダ몬 (달콤)',
    description: '상냥하고 애교 있는 보이스',
  },
  {
    id: '7',
    label: '즈ンダ몬 (츤츤)',
    description: '새침하고 톡 쏘는 보이스',
  },
  {
    id: '2',
    label: '시코쿠 메탄 (노말)',
    description: '차분하고 맑은 여성 보이스',
  },
  {
    id: '0',
    label: '시코쿠 메탄 (달콤)',
    description: '부드럽고 달콤한 여성 보이스',
  },
  {
    id: '8',
    label: '카스가베 츠무기 (노말)',
    description: '친근하고 생기 있는 여성 보이스',
  },
  {
    id: '10',
    label: '아메하루 하우 (노말)',
    description: '나긋나긋한 힐링 보이스',
  },
  {
    id: '9',
    label: '나미네 리츠 (노말)',
    description: '시원하고 당찬 보이스',
  },
  {
    id: '14',
    label: '메이메이 히마리 (노말)',
    description: '발랄한 여동생 톤 보이스',
  },
  {
    id: '13',
    label: '아오야마 류세이 (노말)',
    description: '차분하고 중후한 남성 보이스',
  },
  {
    id: '47',
    label: '켄자키 메스오 (노말)',
    description: '든든하고 무게감 있는 남성 보이스',
  },
]

export function isKnownVoiceId(voiceId: string): boolean {
  return TTS_VOICES.some((voice) => voice.id === voiceId)
}

export function voiceLabel(voiceId: string): string {
  return TTS_VOICES.find((voice) => voice.id === voiceId)?.label ?? voiceId
}
