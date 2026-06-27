function pickRandom(pool: readonly string[]): string {
  return pool[Math.floor(Math.random() * pool.length)]
}

export const GAMBLING_WIN_MESSAGES: readonly string[] = [
  '와, {user}님 오늘 운이 좋으시네요!\n{amount} 획득! 이대로 쉬어야 진짜 고수인데...',
  '{user}님 {amount} 획득!\n...진짜 그만하시죠? 이 정도면 충분하잖아요.',
  '{user}님이 {amount}을(를) 가져갔어요!\n주변에서 부러운 눈빛이 느껴지실 거예요.',
  '오... {user}님 {amount} 획득!\n이런 날도 있는 거죠. 내일은 모를 일이에요.',
  '{user}님, {amount} 획득!\n축하드려요. 근데 이겼다고 기세 올리다가 다 잃는 게 도박이에요. (선생님 같은 소리)',
  '{user}님 드디어 건졌네요! {amount} 획득.\n카지노에서 이기고 일어나는 사람이 최강자래요.',
]

export const GAMBLING_LOSE_MESSAGES: readonly string[] = [
  '{user}님, {amount}을(를) 잃었어요.\n괜찮아요. 이런 날도 있죠. (사실 괜찮지 않죠?)',
  '아... {user}님 {amount} 손실.\n다음에 또 도전하시겠죠? 그게 도박의 함정이에요.',
  '{user}님이 {amount}을(를) 잃었어요.\n하지만 교훈을 얻으셨으니... 아마도요.',
  '{user}님, {amount} 잃으셨네요.\n도박중독 상담 전화는 1336이에요. 진심으로요.',
  '이런... {user}님 {amount} 손실.\n오늘 운이 안 좋았던 것일 뿐이에요. 아마도.',
]

export const GAMBLING_BIGWIN_MESSAGES: readonly string[] = [
  '[대박] {user}님이 {amount}을(를) 따셨어요!\n서버가 들썩들썩하네요. 축하드립니다!',
  '[대박] 와... {user}님 {amount} 획득.\n이 정도면 주변에 소문낼 만하네요.',
  '[대박] {user}님, {amount} 획득!\n이런 판은 평생에 한 번 올까 말까 해요.',
  '[대박] 이게 무슨 일이에요? {user}님이 {amount}을(를) 가져갔어요!\n축하하지만 질투도 약간 나네요.',
]

export const SLOT_JACKPOT_MESSAGES: readonly string[] = [
  '[🚨 잭팟] {user}님이 {amount}을(를) 터뜨렸어요!!!\n이건 진짜 역사적 순간이에요. 축하드립니다!',
  '[🚨 잭팟] 와... {user}님 {amount}!!!\n서버 채팅창이 조용해질 정도의 충격이에요.',
  '[🚨 잭팟] {user}님이 {amount}을(를) 가져갔어요!\n이 확률을 뚫다니, 오늘 뭐라도 드셨어요?',
  '[🚨 잭팟] 미쳤다... {user}님 {amount}!!!\n다들 자리에서 일어나 박수 쳐주세요.',
]

export const SLOT_BIGWIN_MESSAGES: readonly string[] = [
  '✨ {user}님, {amount} 획득!\n이 정도면 진짜 슬롯 고수예요.',
  '✨ 와, {user}님 {amount}!\n심볼이 저렇게까지 잘 맞을 수가...',
  '✨ {user}님이 {amount}을(를) 가져갔어요!\n오늘 자야겠네요. 이 정도면 충분히 즐겼죠.',
]

export const SLOT_NORMAL_WIN_MESSAGES: readonly string[] = [
  '🎉 {user}님, {amount} 획득!\n소소하게 건졌네요. 다음 판이 진짜예요.',
  '🎉 {user}님 {amount}!\n이걸로 오늘 밥값은 하셨겠어요.',
  '🎉 {user}님, {amount} 당첨!\n조금씩 따는 것도 실력이에요.',
]

export const RPS_WIN_MESSAGES: readonly string[] = [
  '{user}님 승리! +1,000원\n봇을 이기다니, 대단해요!',
  '{user}님이 이겼어요! +1,000원\n가위바위보에 재능이 있으신 것 같네요.',
  '{user}님 승리! +1,000원 획득!\n이 정도면 심리전의 달인이에요.',
]

export const RPS_LOSE_MESSAGES: readonly string[] = [
  '{user}님 패배... 안타까워요.\n다음엔 이길 수 있을 거예요. 아마도.',
  '아쉬워요, {user}님.\n봇이 오늘 좀 잘하는 날인 것 같네요.',
  '{user}님 졌어요.\n하지만 가위바위보는 운이 반이라잖아요.',
]

export const RPS_DRAW_MESSAGES: readonly string[] = [
  '무승부!\n심리전의 균형이 맞았네요.',
  '비겼어요!\n둘 다 같은 생각을 했군요.',
  '무승부!\n타이밍이 하나만 달라도 결과가 달랐을 텐데.',
]

export const LOTTERY_JACKPOT_MESSAGES: readonly string[] = [
  '[🎉 대당첨] {user}님, {amount} 당첨!\n이걸 받다니... 정말 운이 좋으시네요!',
  '[🎉 대당첨] 와... {user}님 {amount}!\n주간 복권 역사에 남을 순간이에요.',
  '[🎉 대당첨] {user}님, {amount} 획득!\n이 확률을 뚫다니, 로또도 사보세요.',
]

export const LOTTERY_NORMAL_MESSAGES: readonly string[] = [
  '{user}님, {amount} 당첨!\n없는 것보단 훨씬 낫죠.',
  '{user}님 {amount} 획득!\n소소하지만 확실한 행복이에요.',
  '{user}님, {amount} 당첨이에요.\n다음엔 더 큰 걸 노려보세요!',
]

export const LOTTERY_MISS_MESSAGES: readonly string[] = [
  '아쉽게도 꽝이에요...\n다음 주에 다시 도전해보세요!',
  '이번엔 못 받았네요. 하지만 포기하지 마세요!',
  '꽝이에요. {user}님.\n운은 언젠가 찾아올 거예요. 언젠가.',
]

export const ATTENDANCE_MESSAGES: readonly string[] = [
  '{user}님, 오늘도 출석! +5,000원\n매일 오시는 게 진짜 중요해요.',
  '{user}님 출석 완료! +5,000원\n오늘도 좋은 하루 보내세요.',
  '{user}님, 출석 보상 +5,000원 획득!\n하루 한 번이니 잊지 마세요.',
  '{user}님 와주셨네요! +5,000원\n연속 출석하면 뿌듯하죠.',
]

export function formatMessage(
  template: string,
  vars: Record<string, string>
): string {
  let result = template
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value)
  }
  return result
}

export function pickGamblingWinMessage(
  userMention: string,
  amount: string,
  isBigWin: boolean
): string {
  const pool = isBigWin ? GAMBLING_BIGWIN_MESSAGES : GAMBLING_WIN_MESSAGES
  return formatMessage(pickRandom(pool), { user: userMention, amount })
}

export function pickGamblingLoseMessage(
  userMention: string,
  amount: string
): string {
  return formatMessage(pickRandom(GAMBLING_LOSE_MESSAGES), {
    user: userMention,
    amount,
  })
}

export function pickSlotWinMessage(
  userMention: string,
  amount: string,
  multiplier: number,
  matchCount: number
): string {
  let pool: readonly string[]
  if (matchCount >= 5 && multiplier >= 20) {
    pool = SLOT_JACKPOT_MESSAGES
  } else if (matchCount >= 4 || multiplier >= 6) {
    pool = SLOT_BIGWIN_MESSAGES
  } else {
    pool = SLOT_NORMAL_WIN_MESSAGES
  }
  return formatMessage(pickRandom(pool), { user: userMention, amount })
}

export function pickRpsMessage(
  userMention: string,
  result: 'win' | 'lose' | 'draw'
): string {
  const pool =
    result === 'win'
      ? RPS_WIN_MESSAGES
      : result === 'lose'
      ? RPS_LOSE_MESSAGES
      : RPS_DRAW_MESSAGES
  return formatMessage(pickRandom(pool), { user: userMention })
}

export function pickLotteryMessage(
  userMention: string,
  amount: number,
  amountLabel: string
): string {
  let pool: readonly string[]
  if (amount >= 100000) {
    pool = LOTTERY_JACKPOT_MESSAGES
  } else if (amount > 0) {
    pool = LOTTERY_NORMAL_MESSAGES
  } else {
    pool = LOTTERY_MISS_MESSAGES
  }
  return formatMessage(pickRandom(pool), {
    user: userMention,
    amount: amountLabel,
  })
}

export function pickAttendanceMessage(userMention: string): string {
  return formatMessage(pickRandom(ATTENDANCE_MESSAGES), { user: userMention })
}
