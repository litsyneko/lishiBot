import { badWords as badwordsKoDict } from 'badwords-ko/src/badwords.ko.config.json'

export const MODERATION_GUILD_ID = '1440598081648328816'

export const MODERATION_IMMUNE_ROLE_IDS: readonly string[] = [
  '1475313562930122906',
  '1518191134759981148',
  '1521700866774798497',
]

export type FilterSeverity = 'low' | 'medium' | 'high'

export type FilterResult = {
  readonly matched: boolean
  readonly filter: ModerationFilterKind
  readonly severity: FilterSeverity
  readonly reason: string
}

export type ModerationFilterKind =
  | 'bannedWord'
  | 'inviteLink'
  | 'externalUrl'
  | 'nsfw'
  | 'cryptoSpam'
  | 'personalInfo'
  | 'spam'

// 관리자가 개별로 켜고 끌 수 있는 검열 카테고리.
export type ModerationCategory =
  | 'profanity'
  | 'political'
  | 'nsfw'
  | 'crypto'
  | 'invite'
  | 'externalUrl'
  | 'personalInfo'
  | 'spam'

export const MODERATION_CATEGORIES: readonly {
  readonly key: ModerationCategory
  readonly label: string
}[] = [
  { key: 'profanity', label: '욕설·비하' },
  { key: 'political', label: '정치·정당' },
  { key: 'nsfw', label: '성적·NSFW' },
  { key: 'crypto', label: '코인·외부유도' },
  { key: 'invite', label: '초대링크' },
  { key: 'externalUrl', label: '외부링크' },
  { key: 'personalInfo', label: '개인정보' },
  { key: 'spam', label: '도배·스팸' },
]

export const SEVERITY_RANK: Readonly<Record<FilterSeverity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
}

type BannedWordEntry = {
  readonly pattern: RegExp
  readonly severity: FilterSeverity
  readonly label: string
}

const LIGHT_PROFANITY_ALLOW: ReadonlySet<string> = new Set([
  '시발',
  '시바',
  '시바라지',
  '시바류',
  '시바시바',
  '시바알',
  '시바앙',
  '시방새',
  '아오 ㅅㅂ',
  '아오 시바',
  '아오ㅅㅂ',
  '아오시바',
  '시1발',
  '시-발',
  '시녀',
  '야발',
  '야 발',
])

// badwords-ko 사전은 원래 단어 분할(isProfane)용이라 짧은 항목이 일상어에
// 그대로 포함된다. 문장 전체에 substring 정규식으로 쓰면 오탐이 폭증하므로
// 3글자 미만 항목은 제외하고, 3글자 이상이라도 일상어와 겹치는 항목은 배제한다.
const BADWORDS_KO_MIN_LENGTH = 3

// 사전에서 추가로 제외할 항목(일상어와 충돌 시 여기에 추가).
const BADWORDS_KO_EXCLUDE: ReadonlySet<string> = new Set<string>([])

function buildBadwordsKoPattern(): RegExp | null {
  if (!Array.isArray(badwordsKoDict) || badwordsKoDict.length === 0) return null

  const escaped = badwordsKoDict
    .map((word: string) => word.trim())
    .filter(
      (word: string) =>
        word.length >= BADWORDS_KO_MIN_LENGTH &&
        // 공백 포함 항목(예: "존 나")은 "존 나이스"처럼 정상 문구를
        // 오탐하므로 제외한다.
        !/\s/u.test(word) &&
        !LIGHT_PROFANITY_ALLOW.has(word) &&
        !BADWORDS_KO_EXCLUDE.has(word)
    )
    .map((word: string) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))

  if (escaped.length === 0) return null

  return new RegExp(`(?:${escaped.join('|')})`, 'iu')
}

const BADWORDS_KO_PATTERN = buildBadwordsKoPattern()

const BANNED_WORDS: readonly BannedWordEntry[] = [
  {
    // 보지/자지는 '보다/자다' 활용형(보지 마, 자지 말고)과 충돌하므로
    // 명백한 성적 비속어 복합어에서만 매칭한다.
    pattern:
      /(개보지|왕보지|니보지|네보지|보지년|보지새끼|보지털|개자지|왕자지|자지새끼|자지년)/iu,
    severity: 'high',
    label: '성적 비속어',
  },
  {
    pattern: /(병신|좆|존나|존나라|썅|쌍놈|떢|좃|좇|ㅈㅈ|ㅂㅅ|ㅅㅂ|ㅄ|ㅁㅊ)/iu,
    severity: 'medium',
    label: '비하·욕설',
  },
  {
    pattern:
      /(?:씨바|씨발|씨팔|쉬바|쉬발|쉬팔|슈발|슈벌|쒸발|쒸바|개새|개세끼|개씹|개년|개부랄|개섹|좆밥|보지물|씹새끼|씹질|씹새|씹년|[섊좆좇졷좄좃좉졽썅춍봊]|[ㅈ조][0-9]*까|ㅅㅣㅂㅏㄹ?|ㅂ[0-9]*ㅅ|[ㅄᄲᇪᄺᄡᄣᄦᇠ]|[ㅅㅆᄴ][0-9]*[ㄲㅅㅆᄴㅂ]|[존좉좇][0-9]*나|[자보][0-9]+지|보빨|[봊봋봈볻봁봍][빨이]|[후훚훐훛훋훗훘훟훝훑][장앙]|[엠앰]창|애[미비]|애자|[가-탏탑-힣]색기|(?:[샊샛세쉐쉑쉨쉒객갞갟갯갰갴겍겎겏겤곅곆곇곗곘곜걕걖걗걧걨걬][끼키퀴])|새[키퀴]|[병븅][0-9]*[신딱딲]|미친[가-닣닥-힣]|[믿밑]힌|[염옘][0-9]*병|[샊샛샜샠섹섺셋셌셐셱솃솄솈섁섂섓섔섘]기|[섹섺섻쎅쎆쎇쎽쎾쎿섁섂섃썍썎썏][스쓰]|[지야][0-9]*랄|니[애에]미|갈[0-9]*보[^가-힣]|[뻐뻑뻒뻙뻨][0-9]*[뀨큐킹낑]|꼬[0-9]*추|곧[0-9]*휴|[가-힣]슬아치|자[0-9]*박꼼|빨통|[사싸](?:이코(?!패스)|가지|[0-9]*까시)|육[0-9]*시[랄럴]|육[0-9]*실[알얼할헐]|즐[^가-힣]|찌[0-9]*(?:질이|랭이)|찐[0-9]*따|찐[0-9]*찌버거|창[녀놈]|[가-힣]{2,}충[^가-힣]|[가-힣]{2,}츙|부녀자|화냥년|환[양향]년|호[0-9]*[구모]|조[선센][징]|조센|[쪼쪽쪾](?:[발빨]이|[바빠]리)|盧|무현|찌끄[레래]기|(?:하악){2,}|하[앍앜]|[낭당랑앙항남담람암함][가-힣]+[띠찌]|느[금급]마|文在|在寅|(?<=[^\n])[家哥]|속냐|[tT]l[qQ]kf|Wls|[ㅂ]신|[ㅅ]발|[ㅈ]밥)/iu,
    severity: 'high',
    label: '비하·욕설(강)',
  },
  {
    pattern:
      /(김치녀|한남|한녀|섹스워커|조선족 차별|일베|일간베스트|여성부|남성부)/iu,
    severity: 'high',
    label: '성별·인종 비하',
  },
  {
    pattern: /(독도는 일본|독도는 일본 영토|한국은 일본 땅)/iu,
    severity: 'high',
    label: '영토 비하',
  },
  ...(BADWORDS_KO_PATTERN !== null
    ? [
        {
          pattern: BADWORDS_KO_PATTERN,
          severity: 'high' as const,
          label: '비속어 사전(강)',
        },
      ]
    : []),
]

const POLITICAL_WORDS: readonly BannedWordEntry[] = [
  {
    // '더불어'(함께), '조국'(고향)은 일상어라 정당/정치인 목록에서 제외.
    // 정당 고유명(더불어민주당/조국혁신당)은 그대로 유지한다.
    pattern:
      /(더불어민주당|국민의힘|조국혁신당|개혁신당|진보당|자유당|국민의당|더민주|국힘|좌파|우파(?!루파)|극좌|극우|종북|빨치산)/iu,
    severity: 'high',
    label: '정치·정당 언급',
  },
  {
    pattern:
      /(이재명|윤석열|한동훈|김문수|이준석|박근혜|노무현|문재인|박정희|전두환)/iu,
    severity: 'high',
    label: '정치인 언급',
  },
  {
    pattern: /(계엄|계엄령|부정선거|사회운동)/iu,
    severity: 'medium',
    label: '정치·사회운동 관련',
  },
]

const NSFW_WORDS: readonly BannedWordEntry[] = [
  {
    // 정사(정사각형/결정사항), 자위(자위대/자위권), sex(unisex/middlesex)처럼
    // 일상어와 충돌하는 항목은 문맥/경계를 요구하도록 좁혔다.
    pattern:
      /(섹스|야동|포르노|(?<![a-z])porn|(?<![a-z])sex|hentai|헨타이|(?<![a-z])adult|성인물|av배우|딸딸이|자위행위|자위(?!대|권|력|함|관|병|팀|원)|오나홀|콘돔|19금|R지정|R등급)/iu,
    severity: 'high',
    label: '성적·NSFW',
  },
]

const CRYPTO_SPAM_PATTERNS: readonly BannedWordEntry[] = [
  {
    pattern:
      /(비트코인 투자|코인 투자|하락장|상승장|시드|시드머니|에어드랍|airdrop|가입하면 \d+원|\$\d+ 보너스|수익률 \d+%|월 \d+만원)/iu,
    severity: 'high',
    label: '코인·투자 스팸',
  },
  {
    pattern:
      /(텔레그램|telegra\.me|t\.me\/|오픈카톡|openkakao|오픈채팅|단톡방|비밀 단톡)/iu,
    severity: 'medium',
    label: '외부 서비스 유도',
  },
]

const INVITE_PATTERN =
  /discord(?:app)?\.(?:com\/invite|gg)\/([a-zA-Z0-9-]{2,})/iu

const URL_PATTERN =
  /(https?:\/\/(?!discord(?:app)?\.com|discord\.gg)(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)/giu

const URL_WHITELIST: readonly string[] = [
  'youtube.com',
  'youtu.be',
  'twitch.tv',
  'github.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'tiktok.com',
  'naver.com',
  'naver.me',
  'kakao.com',
  'melon.com',
  'genie.co.kr',
  'spotify.com',
  'soundcloud.com',
  'bandcamp.com',
  'vimeo.com',
  'streamable.com',
  'clippit.tv',
  'wikipedia.org',
  'google.com',
  'gstatic.com',
  'discord.com',
  'discord.gg',
  'tenor.com',
  'giphy.com',
  'imgur.com',
  'prnt.sc',
  'githubusercontent.com',
  'cdn.discordapp.com',
  'media.discordapp.net',
  'images-ext-1.discordapp.net',
  'images-ext-2.discordapp.net',
]

export function isWhitelistedUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return URL_WHITELIST.some((domain) => {
    if (domain === lower || lower.startsWith(`${domain}/`)) return true
    const withHttps = lower.replace(/^https?:\/\//u, '')
    return withHttps === domain || withHttps.startsWith(`${domain}/`)
  })
}

const PERSONAL_INFO_PATTERNS: readonly BannedWordEntry[] = [
  {
    pattern:
      /(?:휴대폰|핸드폰|연락처|전화번호)[^\d]{0,5}(01[016789][-.\s]?\d{3,4}[-.\s]?\d{4})/iu,
    severity: 'high',
    label: '전화번호 공유',
  },
  {
    pattern: /\b\d{6}[\s-]?\d{7}\b/u,
    severity: 'high',
    label: '주민등록번호',
  },
]

const SPAM_CONFIG = {
  maxMessages: 5,
  windowMs: 3_000,
  maxDuplicates: 3,
  duplicateWindowMs: 10_000,
  maxMentions: 5,
  maxLinesCap: 15,
} as const

const TIMEOUT_DURATION_MS: Readonly<Record<FilterSeverity, number>> = {
  low: 10_000,
  medium: 60_000,
  high: 300_000,
}

export type ModerationConfig = {
  readonly guildId: string
  readonly immuneRoleIds: readonly string[]
  readonly bannedWords: readonly BannedWordEntry[]
  readonly politicalWords: readonly BannedWordEntry[]
  readonly nsfwWords: readonly BannedWordEntry[]
  readonly cryptoSpamPatterns: readonly BannedWordEntry[]
  readonly personalInfoPatterns: readonly BannedWordEntry[]
  readonly invitePattern: RegExp
  readonly urlPattern: RegExp
  readonly urlWhitelist: readonly string[]
  readonly isWhitelistedUrl: (url: string) => boolean
  readonly spamConfig: typeof SPAM_CONFIG
  readonly timeoutDurationMs: Readonly<Record<FilterSeverity, number>>
}

export const moderationConfig: ModerationConfig = {
  bannedWords: BANNED_WORDS,
  cryptoSpamPatterns: CRYPTO_SPAM_PATTERNS,
  guildId: MODERATION_GUILD_ID,
  immuneRoleIds: MODERATION_IMMUNE_ROLE_IDS,
  invitePattern: INVITE_PATTERN,
  isWhitelistedUrl,
  nsfwWords: NSFW_WORDS,
  personalInfoPatterns: PERSONAL_INFO_PATTERNS,
  politicalWords: POLITICAL_WORDS,
  spamConfig: SPAM_CONFIG,
  timeoutDurationMs: TIMEOUT_DURATION_MS,
  urlPattern: URL_PATTERN,
  urlWhitelist: URL_WHITELIST,
}
