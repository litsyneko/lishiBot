import { getSupabase } from '../ai/supabase'
import { formatWon } from '../../config/korea'

export type BalanceResult = {
  readonly amount: number
  readonly label: string
}

export type TransferInput = {
  readonly amount: number
  readonly fromUserId: string
  readonly toUserId: string
}

export type AttendanceInput = {
  readonly now: Date
  readonly userId: string
}

export type EconomyMessage = {
  readonly message: string
}

export type EconomyService = {
  readonly addBalance: (userId: string, amount: number) => Promise<BalanceResult>
  readonly claimAttendance: (input: AttendanceInput) => Promise<EconomyMessage>
  readonly getBalance: (userId: string) => Promise<BalanceResult>
  readonly transfer: (input: TransferInput) => Promise<EconomyMessage>
}

const attendanceReward = 1000

export function createEconomyService(): EconomyService {
  async function getBalance(userId: string): Promise<BalanceResult> {
    const supabase = getSupabase()
    if (supabase === null) return balanceResult(0)

    const { data, error } = await supabase
      .from('accounts')
      .select('balance')
      .eq('user_id', userId)
      .maybeSingle()

    if (error !== null) throw new Error(`잔액 조회 실패: ${error.message}`)
    return balanceResult(data?.balance ?? 0)
  }

  async function addBalance(userId: string, amount: number): Promise<BalanceResult> {
    assertPositiveAmount(amount)

    const supabase = getSupabase()
    if (supabase === null) return balanceResult(0)

    const { data, error } = await supabase.rpc('add_balance', {
      p_user_id: userId,
      p_amount: amount,
    })

    if (error !== null) throw new Error(`잔액 추가 실패: ${error.message}`)
    return balanceResult(data ?? 0)
  }

  async function transfer(input: TransferInput): Promise<EconomyMessage> {
    assertPositiveAmount(input.amount)

    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const { data, error } = await supabase.rpc('transfer_balance', {
      p_from_user_id: input.fromUserId,
      p_to_user_id: input.toUserId,
      p_amount: input.amount,
    })

    if (error !== null) throw new Error(`송금 실패: ${error.message}`)
    if (data === false) throw new Error('잔액이 부족해요.')

    return { message: `${formatWon(input.amount)}을(를) 송금했어요.` }
  }

  async function claimAttendance(input: AttendanceInput): Promise<EconomyMessage> {
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const today = koreanDateKey(input.now)

    const { data, error } = await supabase.rpc('claim_attendance', {
      p_user_id: input.userId,
      p_today: today,
      p_reward: attendanceReward,
    })

    if (error !== null) throw new Error(`출석 처리 실패: ${error.message}`)
    if (data === false) throw new Error('오늘은 이미 출석 보상을 받았어요.')

    return { message: `출석 보상 ${formatWon(attendanceReward)}을 받았어요.` }
  }

  return {
    addBalance,
    claimAttendance,
    getBalance,
    transfer,
  }
}

function assertPositiveAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('금액은 1원 이상이어야 해요.')
  }
}

function balanceResult(amount: number): BalanceResult {
  return {
    amount,
    label: `현재 잔액: ${formatWon(amount)}`,
  }
}

function koreanDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Seoul',
    year: 'numeric',
  }).format(date)
}
