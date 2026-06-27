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

export type QuestProgress = {
  readonly gambleCount: number
  readonly rpsCount: number
  readonly claimed: boolean
}

export type LotteryResult = {
  readonly prize: number
  readonly message: string
}

export type DropLeaderboardEntry = {
  readonly userId: string
  readonly totalClaimed: number
  readonly totalAmount: number
}

export type EconomyService = {
  readonly addBalance: (userId: string, amount: number) => Promise<BalanceResult>
  readonly claimAttendance: (input: AttendanceInput) => Promise<EconomyMessage>
  readonly getBalance: (userId: string) => Promise<BalanceResult>
  readonly transfer: (input: TransferInput) => Promise<EconomyMessage>
  readonly recordGamble: (userId: string, bet: number, won: number, win: boolean) => Promise<void>
  readonly getRanking: (limit?: number) => Promise<RankingEntry[]>
  readonly recordQuestProgress: (userId: string, questType: 'gamble' | 'rps') => Promise<void>
  readonly getQuestProgress: (userId: string) => Promise<QuestProgress>
  readonly claimQuestReward: (userId: string) => Promise<EconomyMessage>
  readonly claimLottery: (userId: string) => Promise<LotteryResult>
  readonly recordActivity: (userId: string) => Promise<number>
  readonly getRandomDropSettings: (guildId: string) => Promise<RandomDropSettings | null>
  readonly setRandomDropSettings: (guildId: string, settings: Partial<RandomDropSettings>) => Promise<void>
  readonly createRandomDrop: (guildId: string) => Promise<RandomDrop | null>
  readonly claimRandomDrop: (dropId: string, userId: string, maxClaims: number) => Promise<number | null>
  readonly recordDropClaim: (userId: string, guildId: string, amount: number) => Promise<void>
  readonly getDropLeaderboard: (guildId: string, limit?: number) => Promise<DropLeaderboardEntry[]>
}

export type RandomDropSettings = {
  readonly enabled: boolean
  readonly minAmount: number
  readonly maxAmount: number
  readonly dropsPerDay: number
  readonly startHour: number
  readonly endHour: number
  readonly channelId: string | null
}

export type RandomDrop = {
  readonly id: string
  readonly guildId: string
  readonly amount: number
  readonly remaining: number
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
const questReward = 5000
const questGambleRequired = 3
const questRpsRequired = 1
const activityRewardPer = 100
const activityMessagesPerReward = 10
const activityMaxRewards = 5

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

  async function recordGamble(userId: string, bet: number, won: number, win: boolean): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const { error } = await supabase.rpc('record_gamble', {
      p_user_id: userId,
      p_bet: bet,
      p_won: won,
      p_win: win,
    })

    if (error !== null) throw new Error(`도박 기록 실패: ${error.message}`)
  }

  async function getRanking(limit: number = 10): Promise<RankingEntry[]> {
    const supabase = getSupabase()
    if (supabase === null) return []

    const { data, error } = await supabase.rpc('get_gambling_ranking', { p_limit: limit })

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

  async function recordQuestProgress(userId: string, questType: 'gamble' | 'rps'): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const today = koreanDateKey(new Date())
    const { error } = await supabase.rpc('record_quest_progress', {
      p_user_id: userId,
      p_quest_date: today,
      p_quest_type: questType,
    })

    if (error !== null) throw new Error(`퀘스트 기록 실패: ${error.message}`)
  }

  async function getQuestProgress(userId: string): Promise<QuestProgress> {
    const supabase = getSupabase()
    if (supabase === null) return { gambleCount: 0, rpsCount: 0, claimed: false }

    const today = koreanDateKey(new Date())
    const { data, error } = await supabase
      .from('daily_quests')
      .select('gamble_count, rps_count, claimed')
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

  async function claimQuestReward(userId: string): Promise<EconomyMessage> {
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const today = koreanDateKey(new Date())
    const { data, error } = await supabase.rpc('claim_quest_reward', {
      p_user_id: userId,
      p_quest_date: today,
      p_gamble_required: questGambleRequired,
      p_rps_required: questRpsRequired,
      p_reward: questReward,
    })

    if (error !== null) throw new Error(`퀘스트 보상 수령 실패: ${error.message}`)
    if (data === false) {
      const progress = await getQuestProgress(userId)
      if (progress.claimed) throw new Error('오늘 퀘스트 보상은 이미 받았어요.')
      throw new Error(`퀘스트 미완료! 도박 ${progress.gambleCount}/${questGambleRequired}, 가위바위보 ${progress.rpsCount}/${questRpsRequired}`)
    }

    return { message: `일일 퀘스트 완료! ${formatWon(questReward)}을 받았어요. 🎉` }
  }

  async function claimLottery(userId: string): Promise<LotteryResult> {
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const weekKey = koreanWeekKey(new Date())
    const random = Math.random()

    const { data, error } = await supabase.rpc('claim_lottery', {
      p_user_id: userId,
      p_week_key: weekKey,
      p_random: random,
    })

    if (error !== null) throw new Error(`복권 참여 실패: ${error.message}`)
    if (data === -1) throw new Error('이번 주 복권은 이미 참여했어요.')

    const prize = Number(data ?? 0)
    const message = prize >= 1000000
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

  async function recordActivity(userId: string): Promise<number> {
    const supabase = getSupabase()
    if (supabase === null) return 0

    const today = koreanDateKey(new Date())
    const { data, error } = await supabase.rpc('record_activity', {
      p_user_id: userId,
      p_track_date: today,
      p_reward_per: activityRewardPer,
      p_max_rewards: activityMaxRewards,
    })

    if (error !== null) throw new Error(`활동 기록 실패: ${error.message}`)
    return Number(data ?? 0)
  }

  async function getRandomDropSettings(guildId: string): Promise<RandomDropSettings | null> {
    const supabase = getSupabase()
    if (supabase === null) return null

    const { data, error } = await supabase
      .from('random_drops')
      .select('*')
      .eq('guild_id', guildId)
      .maybeSingle()

    if (error !== null || data === null) return null

    return {
      enabled: data.enabled ?? false,
      minAmount: data.min_amount ?? 1000,
      maxAmount: data.max_amount ?? 50000,
      dropsPerDay: data.drops_per_day ?? 4,
      startHour: data.start_hour ?? 4,
      endHour: data.end_hour ?? 23,
      channelId: data.channel_id ?? null,
    }
  }

  async function setRandomDropSettings(guildId: string, settings: Partial<RandomDropSettings>): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const update: Record<string, unknown> = { guild_id: guildId }
    if (settings.enabled !== undefined) update.enabled = settings.enabled
    if (settings.minAmount !== undefined) update.min_amount = settings.minAmount
    if (settings.maxAmount !== undefined) update.max_amount = settings.maxAmount
    if (settings.dropsPerDay !== undefined) update.drops_per_day = settings.dropsPerDay
    if (settings.startHour !== undefined) update.start_hour = settings.startHour
    if (settings.endHour !== undefined) update.end_hour = settings.endHour
    if (settings.channelId !== undefined) update.channel_id = settings.channelId

    const { error } = await supabase
      .from('random_drops')
      .upsert(update, { onConflict: 'guild_id' })

    if (error !== null) throw new Error(`선착 보상 설정 실패: ${error.message}`)
  }

  async function createRandomDrop(guildId: string): Promise<RandomDrop | null> {
    const supabase = getSupabase()
    if (supabase === null) return null

    const settings = await getRandomDropSettings(guildId)
    if (settings === null || !settings.enabled) return null

    const amount = Math.floor(Math.random() * (settings.maxAmount - settings.minAmount + 1)) + settings.minAmount
    const dropId = `${guildId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const { error } = await supabase
      .from('random_drop_claims')
      .insert({
        drop_id: dropId,
        guild_id: guildId,
        claimed_by: [],
      })

    if (error !== null) throw new Error(`선착 보상 생성 실패: ${error.message}`)

    return {
      id: dropId,
      guildId,
      amount,
      remaining: settings.dropsPerDay,
    }
  }

  async function claimRandomDrop(dropId: string, userId: string, maxClaims: number): Promise<number | null> {
    const supabase = getSupabase()
    if (supabase === null) return null

    const { data, error } = await supabase
      .from('random_drop_claims')
      .select('claimed_by')
      .eq('drop_id', dropId)
      .maybeSingle()

    if (error !== null || data === null) return null

    const claimedBy: string[] = data.claimed_by ?? []
    if (claimedBy.includes(userId)) return null
    if (claimedBy.length >= maxClaims) return null

    claimedBy.push(userId)
    const { error: updateError } = await supabase
      .from('random_drop_claims')
      .update({ claimed_by: claimedBy })
      .eq('drop_id', dropId)

    if (updateError !== null) return null

    return claimedBy.length
  }

  async function recordDropClaim(userId: string, guildId: string, amount: number): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const { error } = await supabase.rpc('record_drop_claim', {
      p_user_id: userId,
      p_guild_id: guildId,
      p_amount: amount,
    })

    if (error !== null) throw new Error(`선착 보상 통계 기록 실패: ${error.message}`)
  }

  async function getDropLeaderboard(guildId: string, limit: number = 10): Promise<DropLeaderboardEntry[]> {
    const supabase = getSupabase()
    if (supabase === null) return []

    const { data, error } = await supabase.rpc('get_drop_leaderboard', {
      p_guild_id: guildId,
      p_limit: limit,
    })

    if (error !== null) throw new Error(`리더보드 조회 실패: ${error.message}`)
    if (data === null) return []

    return (data as Array<Record<string, unknown>>).map((r) => ({
      userId: String(r.user_id ?? ''),
      totalClaimed: Number(r.total_claimed ?? 0),
      totalAmount: Number(r.total_amount ?? 0),
    }))
  }

  return {
    addBalance,
    claimAttendance,
    getBalance,
    transfer,
    recordGamble,
    getRanking,
    recordQuestProgress,
    getQuestProgress,
    claimQuestReward,
    claimLottery,
    recordActivity,
    getRandomDropSettings,
    setRandomDropSettings,
    createRandomDrop,
    claimRandomDrop,
    recordDropClaim,
    getDropLeaderboard,
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
  const koreanDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }))
  const year = koreanDate.getFullYear()
  const start = new Date(koreanDate)
  start.setHours(0, 0, 0, 0)
  const dayOfWeek = start.getDay()
  const monday = new Date(start)
  monday.setDate(start.getDate() - ((dayOfWeek + 6) % 7))
  const weekNum = Math.ceil(((monday.getTime() - new Date(year, 0, 1).getTime()) / 86400000 + 1) / 7)
  return `${year}-W${String(weekNum).padStart(2, '0')}`
}
