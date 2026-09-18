// 사용자가 선택할 수 있는 TTS 목소리 목록.
// 메인봇(/tts 목소리 명령 choices)과 TTS봇(검증·해석)이 공유한다.

export type TtsVoiceOption = {
  readonly id: string
  readonly label: string
  // 목소리 특징 설명. 있으면 선택지에 "이름 - 설명" 형태로 함께 보여준다.
  readonly description?: string
}

export const TTS_VOICES: readonly TtsVoiceOption[] = [
  { id: '657UKtRu5nAoZlRD7610', label: '리시봇 기본 (여자)' },
  { id: 'HB7dC5ezw8hjABxMWEHY', label: '리시봇 기본 (남자)' },
  {
    id: 'uyVNoMrnUku1dZyVEXwD',
    label: '김안나',
    description: '부드럽고 깔끔한 여성 목소리',
  },
  {
    id: 'fUjY9K2nAIwlALOwSiwc',
    label: '유이',
    description: '일본인 여성, 깔끔하고 네츄럴한 보이스',
  },
  {
    id: 'cBOtnpVZNlQ5VJygXGB8',
    label: '유은하',
  },
]

export function isKnownVoiceId(voiceId: string): boolean {
  return TTS_VOICES.some((voice) => voice.id === voiceId)
}

export function voiceLabel(voiceId: string): string {
  return TTS_VOICES.find((voice) => voice.id === voiceId)?.label ?? voiceId
}
