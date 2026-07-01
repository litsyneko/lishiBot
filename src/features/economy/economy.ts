import { formatWon } from '../../config/korea'
import { logger } from '../../utils/logger'
import { getSupabase } from '../ai/supabase'

export type BalanceResult = {
  readonly amount: number
  readonly label: string
}

export type BankResult = {
  readonly balance: number
  readonly bankBalance: number
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

export type LevelUpResult = {
  readonly newLevel: number
  readonly leveledUp: boolean
  readonly reward: number
}

export type ShopItem = {
  readonly itemId: string
  readonly name: string
  readonly description: string
  readonly price: number
  readonly category: string
  readonly emoji: string
}

export type InventoryEntry = {
  readonly itemId: string
  readonly quantity: number
}

export type EconomyService = {
  readonly addBalance: (
    userId: string,
    amount: number
  ) => Promise<BalanceResult>
  readonly claimAttendance: (input: AttendanceInput) => Promise<EconomyMessage>
  readonly getBalance: (userId: string) => Promise<BalanceResult>
  readonly transfer: (input: TransferInput) => Promise<EconomyMessage>
  readonly recordGamble: (
    userId: string,
    bet: number,
    won: number,
    win: boolean
  ) => Promise<void>
  readonly getRanking: (limit?: number) => Promise<RankingEntry[]>
  readonly recordQuestProgress: (
    userId: string,
    questType: 'gamble' | 'rps'
  ) => Promise<void>
  readonly getQuestProgress: (userId: string) => Promise<QuestProgress>
  readonly claimQuestReward: (userId: string) => Promise<EconomyMessage>
  readonly claimLottery: (userId: string) => Promise<LotteryResult>
  readonly recordActivity: (userId: string) => Promise<number>
  readonly addXp: (userId: string, xp: number) => Promise<LevelUpResult>
  readonly getLevel: (userId: string) => Promise<{ level: number; xp: number }>
  readonly getEnabledRandomDropGuilds: () => Promise<readonly string[]>
  readonly getScheduledDropHours: (
    guildId: string,
    dropDate: string
  ) => Promise<readonly number[]>
  readonly setScheduledDropHours: (
    guildId: string,
    dropDate: string,
    hours: readonly number[]
  ) => Promise<void>
  readonly getRandomDropSettings: (
    guildId: string
  ) => Promise<RandomDropSettings | null>
  readonly setRandomDropSettings: (
    guildId: string,
    settings: Partial<RandomDropSettings>
  ) => Promise<void>
  readonly getScheduleNotifiedDate: (guildId: string) => Promise<string | null>
  readonly setScheduleNotifiedDate: (
    guildId: string,
    date: string
  ) => Promise<void>
  readonly getRandomDropSentCount: (
    guildId: string,
    dropDate: string
  ) => Promise<number>
  readonly createRandomDrop: (guildId: string) => Promise<RandomDrop | null>
  readonly recordRandomDropSent: (
    dropId: string,
    guildId: string
  ) => Promise<void>
  readonly claimRandomDrop: (
    dropId: string,
    userId: string,
    maxClaims: number
  ) => Promise<number | null>
  readonly recordDropClaim: (
    userId: string,
    guildId: string,
    amount: number
  ) => Promise<void>
  readonly getDropLeaderboard: (
    guildId: string,
    limit?: number
  ) => Promise<DropLeaderboardEntry[]>
  readonly getShopItems: () => Promise<ShopItem[]>
  readonly buyItem: (userId: string, itemId: string) => Promise<EconomyMessage>
  readonly getInventory: (userId: string) => Promise<InventoryEntry[]>
  readonly useItem: (userId: string, itemId: string) => Promise<EconomyMessage>
  readonly getBankBalance: (userId: string) => Promise<number>
  readonly bankDeposit: (userId: string, amount: number) => Promise<BankResult>
  readonly bankWithdraw: (userId: string, amount: number) => Promise<BankResult>
  readonly claimInterest: (userId: string) => Promise<EconomyMessage>
}

export type RandomDropSettings = {
  readonly enabled: boolean
  readonly minAmount: number
  readonly maxAmount: number
  readonly dropsPerDay: number
  readonly startHour: number
  readonly endHour: number
  readonly channelId: string | null
  readonly adminChannelId: string | null
  readonly mentionRoleId: string | null
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
const attendanceStreakBonus7 = 10000
const attendanceStreakBonus30 = 50000
const activityXpPerMessage = 10
const gambleXpPerBet = 5
const questReward = 5000
const questGambleRequired = 3
const questRpsRequired = 1
const activityRewardPer = 200
const activityMaxRewards = 10
const dayMs = 24 * 60 * 60 * 1000

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

  async function addBalance(
    userId: string,
    amount: number
  ): Promise<BalanceResult> {
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

  async function claimAttendance(
    input: AttendanceInput
  ): Promise<EconomyMessage> {
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const today = koreanDateKey(input.now)

    const { data, error } = await supabase.rpc('claim_attendance', {
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
    userId: string,
    bet: number,
    won: number,
    win: boolean
  ): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const { error } = await supabase.rpc('record_gamble', {
      p_user_id: userId,
      p_bet: bet,
      p_won: won,
      p_win: win,
    })

    if (error !== null) throw new Error(`도박 기록 실패: ${error.message}`)
    void addXp(userId, gambleXpPerBet).catch((e: unknown) =>
      logger.debug(
        'Economy',
        `XP failed: ${e instanceof Error ? e.message : String(e)}`
      )
    )
  }

  async function getRanking(limit = 10): Promise<RankingEntry[]> {
    const supabase = getSupabase()
    if (supabase === null) return []

    const { data, error } = await supabase.rpc('get_gambling_ranking', {
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
    userId: string,
    questType: 'gamble' | 'rps'
  ): Promise<void> {
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
    if (supabase === null)
      return { gambleCount: 0, rpsCount: 0, claimed: false }

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

    if (error !== null)
      throw new Error(`퀘스트 보상 수령 실패: ${error.message}`)
    if (data === false) {
      const progress = await getQuestProgress(userId)
      if (progress.claimed) throw new Error('오늘 퀘스트 보상은 이미 받았어요.')
      throw new Error(
        `퀘스트 미완료! 도박 ${progress.gambleCount}/${questGambleRequired}, 가위바위보 ${progress.rpsCount}/${questRpsRequired}`
      )
    }

    return {
      message: `일일 퀘스트 완료! ${formatWon(questReward)}을 받았어요. 🎉`,
    }
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
    const activityReward = Number(data ?? 0)
    if (activityReward > 0) {
      void addXp(userId, activityXpPerMessage).catch((e: unknown) =>
        logger.debug(
          'Economy',
          `XP failed: ${e instanceof Error ? e.message : String(e)}`
        )
      )
    }
    return activityReward
  }

  async function addXp(userId: string, xp: number): Promise<LevelUpResult> {
    const supabase = getSupabase()
    if (supabase === null) return { newLevel: 1, leveledUp: false, reward: 0 }

    const { data, error } = await supabase.rpc('add_xp', {
      p_user_id: userId,
      p_xp: xp,
    })

    if (error !== null) throw new Error(`XP 추가 실패: ${error.message}`)

    const row = (data as Array<Record<string, unknown>> | null)?.[0]
    if (row === undefined) {
      return { newLevel: 1, leveledUp: false, reward: 0 }
    }

    return {
      newLevel: Number(row.new_level ?? 1),
      leveledUp: Boolean(row.leveled_up),
      reward: Number(row.reward ?? 0),
    }
  }

  async function getLevel(
    userId: string
  ): Promise<{ level: number; xp: number }> {
    const supabase = getSupabase()
    if (supabase === null) return { level: 1, xp: 0 }

    const { data, error } = await supabase
      .from('accounts')
      .select('level, xp')
      .eq('user_id', userId)
      .maybeSingle()

    if (error !== null) throw new Error(`레벨 조회 실패: ${error.message}`)
    return {
      level: data?.level ?? 1,
      xp: data?.xp ?? 0,
    }
  }

  async function getEnabledRandomDropGuilds(): Promise<readonly string[]> {
    const supabase = getSupabase()
    if (supabase === null) return []

    const { data, error } = await supabase
      .from('random_drops')
      .select('guild_id')
      .eq('enabled', true)

    if (error !== null) throw new Error(`활성 길드 조회 실패: ${error.message}`)
    if (data === null) return []

    return data.map((row) => String(row.guild_id ?? ''))
  }

  async function getScheduledDropHours(
    guildId: string,
    dropDate: string
  ): Promise<readonly number[]> {
    const supabase = getSupabase()
    if (supabase === null) return []

    const { data, error } = await supabase
      .from('random_drop_schedule')
      .select('scheduled_hours')
      .eq('guild_id', guildId)
      .eq('drop_date', dropDate)
      .maybeSingle()

    if (error !== null) throw new Error(`스케줄 조회 실패: ${error.message}`)
    if (data === null) return []

    return (data.scheduled_hours as number[] | null) ?? []
  }

  async function setScheduledDropHours(
    guildId: string,
    dropDate: string,
    hours: readonly number[]
  ): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const { error } = await supabase.from('random_drop_schedule').upsert(
      {
        guild_id: guildId,
        drop_date: dropDate,
        scheduled_hours: [...hours],
      },
      { onConflict: 'guild_id,drop_date' }
    )

    if (error !== null) throw new Error(`스케줄 저장 실패: ${error.message}`)
  }

  async function getRandomDropSettings(
    guildId: string
  ): Promise<RandomDropSettings | null> {
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
      adminChannelId: data.admin_channel_id ?? null,
      mentionRoleId: data.mention_role_id ?? null,
    }
  }

  async function setRandomDropSettings(
    guildId: string,
    settings: Partial<RandomDropSettings>
  ): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const update: Record<string, unknown> = { guild_id: guildId }
    if (settings.enabled !== undefined) update.enabled = settings.enabled
    if (settings.minAmount !== undefined) update.min_amount = settings.minAmount
    if (settings.maxAmount !== undefined) update.max_amount = settings.maxAmount
    if (settings.dropsPerDay !== undefined)
      update.drops_per_day = settings.dropsPerDay
    if (settings.startHour !== undefined) update.start_hour = settings.startHour
    if (settings.endHour !== undefined) update.end_hour = settings.endHour
    if (settings.channelId !== undefined) update.channel_id = settings.channelId
    if (settings.adminChannelId !== undefined)
      update.admin_channel_id = settings.adminChannelId
    if (settings.mentionRoleId !== undefined)
      update.mention_role_id = settings.mentionRoleId

    const { error } = await supabase
      .from('random_drops')
      .upsert(update, { onConflict: 'guild_id' })

    if (error !== null) throw new Error(`선착 보상 설정 실패: ${error.message}`)
  }

  async function getScheduleNotifiedDate(
    guildId: string
  ): Promise<string | null> {
    const supabase = getSupabase()
    if (supabase === null) return null

    const { data, error } = await supabase
      .from('random_drops')
      .select('last_schedule_notified_date')
      .eq('guild_id', guildId)
      .maybeSingle()

    if (error !== null) throw new Error(`알림 기록 조회 실패: ${error.message}`)
    return data?.last_schedule_notified_date ?? null
  }

  async function setScheduleNotifiedDate(
    guildId: string,
    date: string
  ): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const { error } = await supabase
      .from('random_drops')
      .update({ last_schedule_notified_date: date })
      .eq('guild_id', guildId)

    if (error !== null) throw new Error(`알림 기록 저장 실패: ${error.message}`)
  }

  async function getRandomDropSentCount(
    guildId: string,
    dropDate: string
  ): Promise<number> {
    const supabase = getSupabase()
    if (supabase === null) return 0

    const range = koreanDayUtcRange(dropDate)
    const { count, error } = await supabase
      .from('random_drop_claims')
      .select('drop_id', { count: 'exact', head: true })
      .eq('guild_id', guildId)
      .gte('created_at', range.startInclusive)
      .lt('created_at', range.endExclusive)

    if (error !== null)
      throw new Error(`선착 보상 발송 기록 조회 실패: ${error.message}`)
    return count ?? 0
  }

  async function createRandomDrop(guildId: string): Promise<RandomDrop | null> {
    const supabase = getSupabase()
    if (supabase === null) return null

    const settings = await getRandomDropSettings(guildId)
    if (settings === null || !settings.enabled) return null

    const amount =
      Math.floor(
        Math.random() * (settings.maxAmount - settings.minAmount + 1)
      ) + settings.minAmount
    const dropId = `${guildId}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`

    return {
      id: dropId,
      guildId,
      amount,
      remaining: settings.dropsPerDay,
    }
  }

  async function recordRandomDropSent(
    dropId: string,
    guildId: string
  ): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const { error } = await supabase.from('random_drop_claims').insert({
      drop_id: dropId,
      guild_id: guildId,
      claimed_by: [],
    })

    if (error !== null) throw new Error(`선착 보상 생성 실패: ${error.message}`)
  }

  async function claimRandomDrop(
    dropId: string,
    userId: string,
    maxClaims: number
  ): Promise<number | null> {
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

  async function recordDropClaim(
    userId: string,
    guildId: string,
    amount: number
  ): Promise<void> {
    const supabase = getSupabase()
    if (supabase === null) return

    const { error } = await supabase.rpc('record_drop_claim', {
      p_user_id: userId,
      p_guild_id: guildId,
      p_amount: amount,
    })

    if (error !== null)
      throw new Error(`선착 보상 통계 기록 실패: ${error.message}`)
  }

  async function getDropLeaderboard(
    guildId: string,
    limit = 10
  ): Promise<DropLeaderboardEntry[]> {
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

  async function getShopItems(): Promise<ShopItem[]> {
    const supabase = getSupabase()
    if (supabase === null) return []

    const { data, error } = await supabase
      .from('shop_items')
      .select('item_id, name, description, price, category, emoji')

    if (error !== null) throw new Error(`상점 조회 실패: ${error.message}`)
    if (data === null) return []

    return (data as Array<Record<string, unknown>>).map((r) => ({
      itemId: String(r.item_id ?? ''),
      name: String(r.name ?? ''),
      description: String(r.description ?? ''),
      price: Number(r.price ?? 0),
      category: String(r.category ?? ''),
      emoji: String(r.emoji ?? ''),
    }))
  }

  async function buyItem(
    userId: string,
    itemId: string
  ): Promise<EconomyMessage> {
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const { data, error } = await supabase.rpc('buy_shop_item', {
      p_user_id: userId,
      p_item_id: itemId,
    })

    if (error !== null) throw new Error(`구매 실패: ${error.message}`)
    if (data === -1)
      throw new Error('잔액이 부족하거나 존재하지 않는 아이템이에요.')

    return {
      message: `${formatWon(Number(data))}을(를) 지불하고 아이템을 구매했어요.`,
    }
  }

  async function getInventory(userId: string): Promise<InventoryEntry[]> {
    const supabase = getSupabase()
    if (supabase === null) return []

    const { data, error } = await supabase
      .from('user_inventory')
      .select('item_id, quantity')
      .eq('user_id', userId)
      .gt('quantity', 0)

    if (error !== null) throw new Error(`인벤토리 조회 실패: ${error.message}`)
    if (data === null) return []

    return (data as Array<Record<string, unknown>>).map((r) => ({
      itemId: String(r.item_id ?? ''),
      quantity: Number(r.quantity ?? 0),
    }))
  }

  async function useItem(
    userId: string,
    itemId: string
  ): Promise<EconomyMessage> {
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const { data: invRow, error: selectError } = await supabase
      .from('user_inventory')
      .select('quantity')
      .eq('user_id', userId)
      .eq('item_id', itemId)
      .maybeSingle()

    if (selectError !== null)
      throw new Error(`인벤토리 조회 실패: ${selectError.message}`)

    const qty = Number(invRow?.quantity ?? 0)
    if (qty <= 0) throw new Error('보유하지 않은 아이템이에요.')

    const newQty = qty - 1
    const { error: consumeError } = await supabase
      .from('user_inventory')
      .update({ quantity: newQty })
      .eq('user_id', userId)
      .eq('item_id', itemId)

    if (consumeError !== null)
      throw new Error(`아이템 사용 실패: ${consumeError.message}`)

    const effect = describeItemEffect(itemId)
    return { message: effect }
  }

  async function getBankBalance(userId: string): Promise<number> {
    const supabase = getSupabase()
    if (supabase === null) return 0

    const { data, error } = await supabase
      .from('accounts')
      .select('bank_balance')
      .eq('user_id', userId)
      .maybeSingle()

    if (error !== null) throw new Error(`은행 잔액 조회 실패: ${error.message}`)
    return data?.bank_balance ?? 0
  }

  async function bankDeposit(
    userId: string,
    amount: number
  ): Promise<BankResult> {
    assertPositiveAmount(amount)
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const { data, error } = await supabase.rpc('bank_deposit', {
      p_user_id: userId,
      p_amount: amount,
    })

    if (error !== null) throw new Error(`입금 실패: ${error.message}`)
    if (data === false) throw new Error('잔액이 부족해요.')

    return await getBalances(userId)
  }

  async function bankWithdraw(
    userId: string,
    amount: number
  ): Promise<BankResult> {
    assertPositiveAmount(amount)
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const { data, error } = await supabase.rpc('bank_withdraw', {
      p_user_id: userId,
      p_amount: amount,
    })

    if (error !== null) throw new Error(`출금 실패: ${error.message}`)
    if (data === false) throw new Error('은행 잔액이 부족해요.')

    return await getBalances(userId)
  }

  async function claimInterest(userId: string): Promise<EconomyMessage> {
    const supabase = getSupabase()
    if (supabase === null) throw new Error('Supabase가 설정되지 않았습니다.')

    const today = koreanDateKey(new Date())
    const { data, error } = await supabase.rpc('claim_interest', {
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

  async function getBalances(userId: string): Promise<BankResult> {
    const supabase = getSupabase()
    if (supabase === null) return { balance: 0, bankBalance: 0 }

    const { data, error } = await supabase
      .from('accounts')
      .select('balance, bank_balance')
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
    transfer,
    recordGamble,
    getRanking,
    recordQuestProgress,
    getQuestProgress,
    claimQuestReward,
    claimLottery,
    recordActivity,
    addXp,
    getLevel,
    getEnabledRandomDropGuilds,
    getScheduledDropHours,
    setScheduledDropHours,
    getRandomDropSettings,
    setRandomDropSettings,
    getScheduleNotifiedDate,
    setScheduleNotifiedDate,
    getRandomDropSentCount,
    createRandomDrop,
    recordRandomDropSent,
    claimRandomDrop,
    recordDropClaim,
    getDropLeaderboard,
    getShopItems,
    buyItem,
    getInventory,
    useItem,
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

function describeItemEffect(itemId: string): string {
  if (itemId === 'luck_boost') {
    return '🍀 다음 도박에서 행운이 +10% 증가해요.'
  }
  if (itemId === 'double_xp') {
    return '⚡ 30분간 경험치가 2배로 적립돼요.'
  }
  if (itemId === 'mystery_box') {
    const prize = 5000 + Math.floor(Math.random() * 96001)
    return `🎁 미스터리 상자에서 ${formatWon(
      prize
    )}을(를) 획득했어요! (실제 지급은 추후 연동 예정)`
  }
  return '아이템을 사용했어요.'
}

function koreanDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Seoul',
    year: 'numeric',
  }).format(date)
}

function koreanDayUtcRange(dropDate: string): {
  readonly endExclusive: string
  readonly startInclusive: string
} {
  const start = new Date(`${dropDate}T00:00:00+09:00`)
  const end = new Date(start.getTime() + dayMs)
  return {
    endExclusive: end.toISOString(),
    startInclusive: start.toISOString(),
  }
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
