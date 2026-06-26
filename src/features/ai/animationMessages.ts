export type AiStage = 'generating' | 'permission' | 'understanding' | 'executing' | 'completed'

const KIRAKIRA = '<a:kirakira:1519382939778158784>'

const STAGE_MESSAGES: Readonly<Record<AiStage, string>> = {
  generating: `${KIRAKIRA} AI가 **최종답변**을 생각하고 있어요..`,
  permission: `${KIRAKIRA} AI가 당신의 권한을 확인하고 있어요..`,
  understanding: `${KIRAKIRA} AI가 당신의 **질문을 파악**하고 있어요..`,
  executing: `${KIRAKIRA} AI가 **요청한 작업을 실행**하고 있어요..`,
  completed: `> <a:congratulations:1519382952042299573> **작업 완료**`,
}

export function formatStageMessage(stage: AiStage, toolName?: string): string {
  const base = STAGE_MESSAGES[stage] ?? ''
  if (stage === 'completed' && toolName !== undefined) {
    return `${base} (${toolName})`
  }
  return base
}

