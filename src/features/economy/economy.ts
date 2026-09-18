import { formatWon } from '../../config/korea'
import { getSupabase } from '../ai/supabase'

export type BalanceResult = {
  readonly amount: number
  readonly label: string
}

// 관리자 회수 결과. 잔액이 부족하면 있는 만큼만 차감된다(0 바닥).
export type SubtractResult = {
  readonly subtracted: number
  readonly newBalance: number
}

export type BankResult = {
  readonly balance: number
  readonly bankBalance: number
}

export type TransferInput = {
  readonly amount: number
  readonly guildId: string
  readonly fromUserId: string
  readonly toUserId: string
}

export type AttendanceInput = {
  readonly guildId: string
  readonly now: Date
  readonly userId: string
}

export type EconomyMessage = {
  readonly message: string
}

export type QuestProgress = {
  readonly gambleCount: number
  readonly rpsCount: number
  readonly claimed: boolean
}

export type LotteryResult = {
  readonly prize: number
  readonly message: string
}

export type EconomyService = {
  readonly addBalance: (
    guildId: string,
    userId: string,
    amount: number
  ) => Promise<BalanceResult>
  readonly claimAttendance: (input: AttendanceInput) => Promise<EconomyMessage>
  readonly getBalance: (
    guildId: string,
    userId: string
  ) => Promise<BalanceResult>
  readonly subtractBalance: (
    guildId: string,
    userId: string,
    amount: number
  ) => Promise<SubtractResult>
  readonly transfer: (input: TransferInput) => Promise<EconomyMessage>
  readonly recordGamble: (
    guildId: string,
    userId: string,
    bet: number,
    won: number,
    win: boolean
  ) => Promise<void>
  readonly getRanking: (
    guildId: string,
    limit?: number
  ) => Promise<RankingEntry[]>
  readonly recordQuestProgress: (
    guildId: string,
    userId: string,
    questType: 'gamble' | 'rps'
  ) => Promise<void>
  readonly getQuestProgress: (
    guildId: string,
    userId: string
  ) => Promise<QuestProgress>
  readonly claimQuestReward: (
    guildId: string,
    userId: string
  ) => Promise<EconomyMessage>
  readonly claimLottery: (
    guildId: string,
    userId: string
  ) => Promise<LotteryResult>
  readonly recordActivity: (guildId: string, userId: string) => Promise<number>
  readonly getBankBalance: (guildId: string, userId: string) => Promise<number>
  readonly bankDeposit: (
    guildId: string,
    userId: string,
    amount: number
  ) => Promise<BankResult>
  readonly bankWithdraw: (
    guildId: string,
    userId: string,
    amount: number
  ) => Promise<BankResult>
  readonly claimInterest: (
    guildId: string,
    userId: string
  ) => Promise<EconomyMessage>
}

export type RankingEntry = {
  readonly userId: string
  readonly totalBet: number
  readonly totalWon: number
  readonly net: number
  readonly betCount: number
  readonly winCount: number
  readonly winRate: number
}

const attendanceReward = 5000
const attendanceStreakBonus7 = 10000
const attendanceStreakBonus30 = 50000
const questReward = 5000
const questGambleRequired = 3
const questRpsRequired = 1
const activityRewardPer = 200
const activityMaxRewards = 10

export function createEconomyService(): EconomyService {
  async function getBalance(
    guildId: string,
    userId: string
  ): Promise<BalanceResult> {
    const supabase = getSupabase()
    if (supabase === null) return balanceResult(0)

    const { data, error } = await supabase
      .from('accounts')
      .select('balance')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .maybeSingle()

    if (error !== null) throw new Error(`잔액 조회 실패: ${error.message}`)
    return balanceResult(data?.balance ?? 0)
  }

  async function addBalance(
    guildId: string,
    userId: string,
    amount: number
  ): Promise<BalanceResult> {
    assertPositiveAmount(amount)

    const supabase = getSupabase()
    if (supabase === null) return balanceResult(0)

    const { data, error } = await supabase.rpc('add_balance', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_amount: amount,
    })

    if (error !== null) throw new Error(`잔액 추가 실패: ${error.message}`)
    return balanceResult(data ?? 0)
  }

  // 관리자 회수. 잔액이 부족하면 있는 만큼만 차감된다(0 바닥).
  async function subtractBalance(
    guildId: string,
    userId: string,
    amount: number
  ): Promise<SubtractResult> {
    assertPositiveAmount(amount)

    const supabase = getSupabase()
    if (supabase === null) return { newBalance: 0, subtracted: 0 }

    const { data, error } = await supabase.rpc('admin_subtract_balance', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_amount: amount,
    })

    if (error !== null) throw new Error(`잔액 회수 실패: ${error.message}`)

    const row = Array.isArray(data) ? data[0] : data
    return {
      newBalance: Number(row?.new_balance ?? 0),
      subtracted: Number(row?.subtracted ?? 0),
    }
  }

  async function transfer(input: TransferInput): Promise<EconomyMessage> {
    assertPositiveAmount(input.amount)

    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const { data, error } = await supabase.rpc('transfer_balance', {
      p_guild_id: input.guildId,
      p_from_user_id: input.fromUserId,
      p_to_user_id: input.toUserId,
      p_amount: input.amount,
    })

    if (error !== null) throw new Error(`송금 실패: ${error.message}`)
    if (data === false) throw new Error('잔액이 부족해요.')

    return { message: `${formatWon(input.amount)}을(를) 송금했어요.` }
  }

  async function claimAttendance(
    input: AttendanceInput
  ): Promise<EconomyMessage> {
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const today = koreanDateKey(input.now)

    const { data, error } = await supabase.rpc('claim_attendance', {
      p_guild_id: input.guildId,
      p_user_id: input.userId,
      p_today: today,
      p_reward: attendanceReward,
      p_streak_bonus_7: attendanceStreakBonus7,
      p_streak_bonus_30: attendanceStreakBonus30,
    })

    if (error !== null) throw new Error(`출석 처리 실패: ${error.message}`)
    if (data === -1) throw new Error('오늘은 이미 출석 보상을 받았어요.')

    const totalReward = Number(data ?? attendanceReward)
    const bonusText =
      totalReward > attendanceReward
        ? ` (연속 출석 보너스 +${formatWon(
            totalReward - attendanceReward
          )} 포함!)`
        : ''
    return {
      message: `출석 보상 ${formatWon(totalReward)}을 받았어요.${bonusText}`,
    }
  }

  async function recordGamble(
    guildId: string,
    userId: string,
    bet: number,
    won: number,
    win: boolean
  ): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const { error } = await supabase.rpc('record_gamble', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_bet: bet,
      p_won: won,
      p_win: win,
    })

    if (error !== null) throw new Error(`도박 기록 실패: ${error.message}`)
  }

  async function getRanking(
    guildId: string,
    limit = 10
  ): Promise<RankingEntry[]> {
    const supabase = getSupabase()
    if (supabase === null) return []

    const { data, error } = await supabase.rpc('get_gambling_ranking', {
      p_guild_id: guildId,
      p_limit: limit,
    })

    if (error !== null) throw new Error(`순위 조회 실패: ${error.message}`)
    if (data === null) return []

    return (data as Array<Record<string, unknown>>).map((r) => ({
      userId: String(r.user_id ?? ''),
      totalBet: Number(r.total_bet ?? 0),
      totalWon: Number(r.total_won ?? 0),
      net: Number(r.net ?? 0),
      betCount: Number(r.bet_count ?? 0),
      winCount: Number(r.win_count ?? 0),
      winRate: Number(r.win_rate ?? 0),
    }))
  }

  async function recordQuestProgress(
    guildId: string,
    userId: string,
    questType: 'gamble' | 'rps'
  ): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const today = koreanDateKey(new Date())
    const { error } = await supabase.rpc('record_quest_progress', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_quest_date: today,
      p_quest_type: questType,
    })

    if (error !== null) throw new Error(`퀘스트 기록 실패: ${error.message}`)
  }

  async function getQuestProgress(
    guildId: string,
    userId: string
  ): Promise<QuestProgress> {
    const supabase = getSupabase()
    if (supabase === null)
      return { gambleCount: 0, rpsCount: 0, claimed: false }

    const today = koreanDateKey(new Date())
    const { data, error } = await supabase
      .from('daily_quests')
      .select('gamble_count, rps_count, claimed')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .eq('quest_date', today)
      .maybeSingle()

    if (error !== null) throw new Error(`퀘스트 조회 실패: ${error.message}`)
    if (data === null) return { gambleCount: 0, rpsCount: 0, claimed: false }

    return {
      gambleCount: data.gamble_count ?? 0,
      rpsCount: data.rps_count ?? 0,
      claimed: data.claimed ?? false,
    }
  }

  async function claimQuestReward(
    guildId: string,
    userId: string
  ): Promise<EconomyMessage> {
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const today = koreanDateKey(new Date())
    const { data, error } = await supabase.rpc('claim_quest_reward', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_quest_date: today,
      p_gamble_required: questGambleRequired,
      p_rps_required: questRpsRequired,
      p_reward: questReward,
    })

    if (error !== null)
      throw new Error(`퀘스트 보상 수령 실패: ${error.message}`)
    if (data === false) {
      const progress = await getQuestProgress(guildId, userId)
      if (progress.claimed) throw new Error('오늘 퀘스트 보상은 이미 받았어요.')
      throw new Error(
        `퀘스트 미완료! 도박 ${progress.gambleCount}/${questGambleRequired}, 가위바위보 ${progress.rpsCount}/${questRpsRequired}`
      )
    }

    return {
      message: `일일 퀘스트 완료! ${formatWon(questReward)}을 받았어요. 🎉`,
    }
  }

  async function claimLottery(
    guildId: string,
    userId: string
  ): Promise<LotteryResult> {
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const weekKey = koreanWeekKey(new Date())
    const random = Math.random()

    const { data, error } = await supabase.rpc('claim_lottery', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_week_key: weekKey,
      p_random: random,
    })

    if (error !== null) throw new Error(`복권 참여 실패: ${error.message}`)
    if (data === -1) throw new Error('이번 주 복권은 이미 참여했어요.')

    const prize = Number(data ?? 0)
    const message =
      prize >= 1000000
        ? `🎉 대박! ${formatWon(prize)} 당첨!`
        : prize >= 100000
        ? `🥳 ${formatWon(prize)} 당첨!`
        : prize >= 10000
        ? `😊 ${formatWon(prize)} 당첨!`
        : prize > 0
        ? `소소하게 ${formatWon(prize)} 당첨!`
        : `꽝! 다음 주에 다시 도전해요.`

    return { prize, message }
  }

  async function recordActivity(
    guildId: string,
    userId: string
  ): Promise<number> {
    const supabase = getSupabase()
    if (supabase === null) return 0

    const today = koreanDateKey(new Date())
    const { data, error } = await supabase.rpc('record_activity', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_track_date: today,
      p_reward_per: activityRewardPer,
      p_max_rewards: activityMaxRewards,
    })

    if (error !== null) throw new Error(`활동 기록 실패: ${error.message}`)
    return Number(data ?? 0)
  }

  async function getBankBalance(
    guildId: string,
    userId: string
  ): Promise<number> {
    const supabase = getSupabase()
    if (supabase === null) return 0

    const { data, error } = await supabase
      .from('accounts')
      .select('bank_balance')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .maybeSingle()

    if (error !== null) throw new Error(`은행 잔액 조회 실패: ${error.message}`)
    return data?.bank_balance ?? 0
  }

  async function bankDeposit(
    guildId: string,
    userId: string,
    amount: number
  ): Promise<BankResult> {
    assertPositiveAmount(amount)
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const { data, error } = await supabase.rpc('bank_deposit', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_amount: amount,
    })

    if (error !== null) throw new Error(`입금 실패: ${error.message}`)
    if (data === false) throw new Error('잔액이 부족해요.')

    return await getBalances(guildId, userId)
  }

  async function bankWithdraw(
    guildId: string,
    userId: string,
    amount: number
  ): Promise<BankResult> {
    assertPositiveAmount(amount)
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const { data, error } = await supabase.rpc('bank_withdraw', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_amount: amount,
    })

    if (error !== null) throw new Error(`출금 실패: ${error.message}`)
    if (data === false) throw new Error('은행 잔액이 부족해요.')

    return await getBalances(guildId, userId)
  }

  async function claimInterest(
    guildId: string,
    userId: string
  ): Promise<EconomyMessage> {
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const today = koreanDateKey(new Date())
    const { data, error } = await supabase.rpc('claim_interest', {
      p_guild_id: guildId,
      p_user_id: userId,
      p_today: today,
    })

    if (error !== null) throw new Error(`이자 수령 실패: ${error.message}`)
    if (data === -2) throw new Error('오늘은 이미 이자를 수령했어요.')

    const interest = Number(data ?? 0)
    if (interest === 0) {
      return { message: '예금이 없어 이자를 받지 못했어요.' }
    }
    return { message: `은행 이자 ${formatWon(interest)}을 받았어요.` }
  }

  async function getBalances(
    guildId: string,
    userId: string
  ): Promise<BankResult> {
    const supabase = getSupabase()
    if (supabase === null) return { balance: 0, bankBalance: 0 }

    const { data, error } = await supabase
      .from('accounts')
      .select('balance, bank_balance')
      .eq('guild_id', guildId)
      .eq('user_id', userId)
      .maybeSingle()

    if (error !== null) throw new Error(`잔액 조회 실패: ${error.message}`)
    return {
      balance: data?.balance ?? 0,
      bankBalance: data?.bank_balance ?? 0,
    }
  }

  return {
    addBalance,
    claimAttendance,
    getBalance,
    subtractBalance,
    transfer,
    recordGamble,
    getRanking,
    recordQuestProgress,
    getQuestProgress,
    claimQuestReward,
    claimLottery,
    recordActivity,
    getBankBalance,
    bankDeposit,
    bankWithdraw,
    claimInterest,
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

function koreanWeekKey(date: Date): string {
  const koreanDate = new Date(
    date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' })
  )
  const year = koreanDate.getFullYear()
  const start = new Date(koreanDate)
  start.setHours(0, 0, 0, 0)
  const dayOfWeek = start.getDay()
  const monday = new Date(start)
  monday.setDate(start.getDate() - ((dayOfWeek + 6) % 7))
  const weekNum = Math.ceil(
    ((monday.getTime() - new Date(year, 0, 1).getTime()) / 86400000 + 1) / 7
  )
  return `${year}-W${String(weekNum).padStart(2, '0')}`
}
