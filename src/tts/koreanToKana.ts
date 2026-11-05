/**
 * 한국어 발음 음운 규칙 및 가타카나(VOICEVOX) 변환기
 *
 * 한글 유니코드를 초성·중성·종성으로 분해하고,
 * 한국어 음운 변동(비음화, 연음, 유음화 등)을 적용한 뒤
 * VOICEVOX가 가장 자연스럽게 발음할 수 있는 일본어 가타카나 음소열로 변환합니다.
 */

// 초성 19개
const CHOSUNG = [
  'ㄱ',
  'ㄲ',
  'ㄴ',
  'ㄷ',
  'ㄸ',
  'ㄹ',
  'ㅁ',
  'ㅂ',
  'ㅃ',
  'ㅅ',
  'ㅆ',
  'ㅇ',
  'ㅈ',
  'ㅉ',
  'ㅊ',
  'ㅋ',
  'ㅌ',
  'ㅍ',
  'ㅎ',
] as const

// 중성 21개
const JUNGSUNG = [
  'ㅏ',
  'ㅐ',
  'ㅑ',
  'ㅒ',
  'ㅓ',
  'ㅔ',
  'ㅕ',
  'ㅖ',
  'ㅗ',
  'ㅘ',
  'ㅙ',
  'ㅚ',
  'ㅛ',
  'ㅜ',
  'ㅝ',
  'ㅞ',
  'ㅟ',
  'ㅠ',
  'ㅡ',
  'ㅢ',
  'ㅣ',
] as const

// 종성 28개 (0은 받침 없음)
const JONGSUNG = [
  '',
  'ㄱ',
  'ㄲ',
  'ㄳ',
  'ㄴ',
  'ㄵ',
  'ㄶ',
  'ㄷ',
  'ㄹ',
  'ㄺ',
  'ㄻ',
  'ㄼ',
  'ㄽ',
  'ㄾ',
  'ㄿ',
  'ㅀ',
  'ㅁ',
  'ㅂ',
  'ㅄ',
  'ㅅ',
  'ㅆ',
  'ㅇ',
  'ㅈ',
  'ㅊ',
  'ㅋ',
  'ㅌ',
  'ㅍ',
  'ㅎ',
] as const

type Syllable = {
  cho: string
  jung: string
  jong: string
  char: string
}

function decomposeHangul(char: string): Syllable | null {
  const code = char.charCodeAt(0)
  if (code < 0xac00 || code > 0xd7a3) return null
  const offset = code - 0xac00
  const choIdx = Math.floor(offset / (21 * 28))
  const jungIdx = Math.floor((offset % (21 * 28)) / 28)
  const jongIdx = offset % 28

  return {
    cho: CHOSUNG[choIdx] ?? '',
    jung: JUNGSUNG[jungIdx] ?? '',
    jong: JONGSUNG[jongIdx] ?? '',
    char,
  }
}

/**
 * 한국어 음운 규칙 적용 (비음화, 연음 등)
 */
function applyPhonologicalRules(syllables: Syllable[]): Syllable[] {
  const result: Syllable[] = syllables.map((s) => ({ ...s }))

  for (let i = 0; i < result.length - 1; i++) {
    const cur = result[i]
    const next = result[i + 1]

    if (!cur || !next) continue

    // 1. 연음 법칙: 앞 음절에 받침이 있고 뒷 음절 초성이 'ㅇ'인 경우
    // 예: 한국어(하-ㄴ-ㄱ-ㅜ-ㄱ, ㅇ-ㅓ) -> 한구거 (ㄱ이 다음 음절 초성으로 이동)
    if (cur.jong && cur.jong !== '' && cur.jong !== 'ㅇ' && next.cho === 'ㅇ') {
      let movedCho = cur.jong
      if (movedCho === 'ㄳ') {
        cur.jong = 'ㄱ'
        movedCho = 'ㅅ'
      } else if (movedCho === 'ㄵ') {
        cur.jong = 'ㄴ'
        movedCho = 'ㅈ'
      } else if (movedCho === 'ㄶ') {
        cur.jong = 'ㄴ'
        movedCho = 'ㅎ'
      } else if (movedCho === 'ㄺ') {
        cur.jong = 'ㄹ'
        movedCho = 'ㄱ'
      } else if (movedCho === 'ㄻ') {
        cur.jong = 'ㄹ'
        movedCho = 'ㅁ'
      } else if (movedCho === 'ㄼ') {
        cur.jong = 'ㄹ'
        movedCho = 'ㅂ'
      } else if (movedCho === 'ㄽ') {
        cur.jong = 'ㄹ'
        movedCho = 'ㅅ'
      } else if (movedCho === 'ㄾ') {
        cur.jong = 'ㄹ'
        movedCho = 'ㅌ'
      } else if (movedCho === 'ㄿ') {
        cur.jong = 'ㄹ'
        movedCho = 'ㅍ'
      } else if (movedCho === 'ㅀ') {
        cur.jong = 'ㄹ'
        movedCho = 'ㅎ'
      } else if (movedCho === 'ㅄ') {
        cur.jong = 'ㅂ'
        movedCho = 'ㅅ'
      } else {
        cur.jong = ''
      }

      // 홑받침/쌍받침 이동
      if (movedCho === 'ㄲ') movedCho = 'ㅋ'
      else if (movedCho === 'ㅆ') movedCho = 'ㅅ'
      else if (['ㄷ', 'ㅅ', 'ㅈ', 'ㅊ', 'ㅌ', 'ㅎ'].includes(movedCho))
        movedCho = 'ㄷ'

      next.cho = movedCho
      continue
    }

    // 2. 비음화: 받침 ㄱ, ㄷ, ㅂ 뒤에 ㄴ, ㅁ이 올 때 -> ㅇ, ㄴ, ㅁ으로 변음
    // 예: 감사합니다(합-니 -> 함-니)
    const isNextNasal = next.cho === 'ㄴ' || next.cho === 'ㅁ'
    if (isNextNasal) {
      if (['ㄱ', 'ㄲ', 'ㅋ', 'ㄳ', 'ㄺ'].includes(cur.jong)) {
        cur.jong = 'ㅇ'
      } else if (
        ['ㄷ', 'ㅅ', 'ㅆ', 'ㅈ', 'ㅊ', 'ㅌ', 'ㅎ'].includes(cur.jong)
      ) {
        cur.jong = 'ㄴ'
      } else if (['ㅂ', 'ㅍ', 'ㄼ', 'ㄿ', 'ㅄ'].includes(cur.jong)) {
        cur.jong = 'ㅁ'
      }
    }
  }

  return result
}

/** 초성과 중성을 일본어 가타카나 음절로 변환 */
function syllableToKana(cho: string, jung: string): string {
  // 모음별 기본 가타카나 (초성이 ㅇ일 때)
  const VOWEL_BASE: Record<string, string> = {
    ㅏ: 'ア',
    ㅐ: 'エ',
    ㅑ: 'ヤ',
    ㅒ: 'イェ',
    ㅓ: 'オ',
    ㅔ: 'エ',
    ㅕ: 'ヨ',
    ㅖ: 'イェ',
    ㅗ: 'オ',
    ㅘ: 'ワ',
    ㅙ: 'ウェ',
    ㅚ: 'ウェ',
    ㅛ: 'ヨ',
    ㅜ: 'ウ',
    ㅝ: 'ウォ',
    ㅞ: 'ウェ',
    ㅟ: 'ウィ',
    ㅠ: 'ユ',
    ㅡ: 'ウ',
    ㅢ: 'ウィ',
    ㅣ: 'イ',
  }

  if (cho === 'ㅇ') {
    return VOWEL_BASE[jung] ?? 'ア'
  }

  // 자음 + 모음 조합 테이블
  const TABLE: Record<string, Record<string, string>> = {
    ㄱ: {
      ㅏ: 'カ',
      ㅐ: 'ケ',
      ㅑ: 'キャ',
      ㅓ: 'コ',
      ㅔ: 'ケ',
      ㅕ: 'キョ',
      ㅗ: 'コ',
      ㅘ: 'クァ',
      ㅙ: 'クェ',
      ㅚ: 'クェ',
      ㅛ: 'キョ',
      ㅜ: 'ク',
      ㅝ: 'クォ',
      ㅞ: 'クェ',
      ㅟ: 'クィ',
      ㅠ: 'キュ',
      ㅡ: 'ク',
      ㅢ: 'クィ',
      ㅣ: 'キ',
    },
    ㄲ: {
      ㅏ: 'ッカ',
      ㅐ: 'ッケ',
      ㅑ: 'ッキャ',
      ㅓ: 'ッコ',
      ㅔ: 'ッケ',
      ㅕ: 'ッキョ',
      ㅗ: 'ッコ',
      ㅘ: 'ックァ',
      ㅙ: 'ックェ',
      ㅚ: 'ックェ',
      ㅛ: 'ッキョ',
      ㅜ: 'ック',
      ㅝ: 'ックォ',
      ㅞ: 'ックェ',
      ㅟ: 'ックィ',
      ㅠ: 'ッキュ',
      ㅡ: 'ック',
      ㅢ: 'ックィ',
      ㅣ: 'ッキ',
    },
    ㄴ: {
      ㅏ: 'ナ',
      ㅐ: 'ネ',
      ㅑ: 'ニャ',
      ㅓ: 'ノ',
      ㅔ: 'ネ',
      ㅕ: 'ニョ',
      ㅗ: 'ノ',
      ㅘ: 'ヌァ',
      ㅙ: 'ヌェ',
      ㅚ: 'ヌェ',
      ㅛ: 'ニョ',
      ㅜ: 'ヌ',
      ㅝ: 'ヌォ',
      ㅞ: 'ヌェ',
      ㅟ: 'ヌィ',
      ㅠ: 'ニュ',
      ㅡ: 'ヌ',
      ㅢ: 'ヌィ',
      ㅣ: 'ニ',
    },
    ㄷ: {
      ㅏ: 'タ',
      ㅐ: 'テ',
      ㅑ: 'チャ',
      ㅓ: 'ト',
      ㅔ: 'テ',
      ㅕ: 'チョ',
      ㅗ: 'ト',
      ㅘ: 'トゥァ',
      ㅙ: 'トゥェ',
      ㅚ: 'トェ',
      ㅛ: 'チョ',
      ㅜ: 'トゥ',
      ㅝ: 'トゥォ',
      ㅞ: 'トゥェ',
      ㅟ: 'ティ',
      ㅠ: 'テュ',
      ㅡ: 'トゥ',
      ㅢ: 'ティ',
      ㅣ: 'ティ',
    },
    ㄸ: {
      ㅏ: 'ッタ',
      ㅐ: 'ッテ',
      ㅑ: 'ッチャ',
      ㅓ: 'ット',
      ㅔ: 'ッテ',
      ㅕ: 'ッチョ',
      ㅗ: 'ット',
      ㅘ: 'ットゥァ',
      ㅙ: 'ットゥェ',
      ㅚ: 'ットェ',
      ㅛ: 'ッチョ',
      ㅜ: 'ットゥ',
      ㅝ: 'ットゥォ',
      ㅞ: 'ットゥェ',
      ㅟ: 'ッティ',
      ㅠ: 'ッテュ',
      ㅡ: 'ットゥ',
      ㅢ: 'ッティ',
      ㅣ: 'ッティ',
    },
    ㄹ: {
      ㅏ: 'ラ',
      ㅐ: 'レ',
      ㅑ: 'リャ',
      ㅓ: 'ロ',
      ㅔ: 'レ',
      ㅕ: 'リョ',
      ㅗ: 'ロ',
      ㅘ: 'ルァ',
      ㅙ: 'ルェ',
      ㅚ: 'ルェ',
      ㅛ: 'リョ',
      ㅜ: 'ル',
      ㅝ: 'ルォ',
      ㅞ: 'ルェ',
      ㅟ: 'ルィ',
      ㅠ: 'リュ',
      ㅡ: 'ル',
      ㅢ: 'ルィ',
      ㅣ: 'リ',
    },
    ㅁ: {
      ㅏ: 'マ',
      ㅐ: 'メ',
      ㅑ: 'ミャ',
      ㅓ: 'モ',
      ㅔ: 'メ',
      ㅕ: 'ミョ',
      ㅗ: 'モ',
      ㅘ: 'ムァ',
      ㅙ: 'ムェ',
      ㅚ: 'ムェ',
      ㅛ: 'ミョ',
      ㅜ: 'ム',
      ㅝ: 'ムォ',
      ㅞ: 'ムェ',
      ㅟ: 'ムィ',
      ㅠ: 'ミュ',
      ㅡ: 'ム',
      ㅢ: 'ムィ',
      ㅣ: 'ミ',
    },
    ㅂ: {
      ㅏ: 'パ',
      ㅐ: 'ペ',
      ㅑ: 'ピャ',
      ㅓ: 'ポ',
      ㅔ: 'ペ',
      ㅕ: 'ピョ',
      ㅗ: 'ポ',
      ㅘ: 'プァ',
      ㅙ: 'プェ',
      ㅚ: 'プェ',
      ㅛ: 'ピョ',
      ㅜ: 'プ',
      ㅝ: 'プォ',
      ㅞ: 'プェ',
      ㅟ: 'プィ',
      ㅠ: 'ピュ',
      ㅡ: 'プ',
      ㅢ: 'プィ',
      ㅣ: 'ピ',
    },
    ㅃ: {
      ㅏ: 'ッパ',
      ㅐ: 'ッペ',
      ㅑ: 'ッピャ',
      ㅓ: 'ッポ',
      ㅔ: 'ッペ',
      ㅕ: 'ッピョ',
      ㅗ: 'ッポ',
      ㅘ: 'ップァ',
      ㅙ: 'ップェ',
      ㅚ: 'ップェ',
      ㅛ: 'ッピョ',
      ㅜ: 'ップ',
      ㅝ: 'ップォ',
      ㅞ: 'ップェ',
      ㅟ: 'ップィ',
      ㅠ: 'ッピュ',
      ㅡ: 'ップ',
      ㅢ: 'ップィ',
      ㅣ: 'ッピ',
    },
    ㅅ: {
      ㅏ: 'サ',
      ㅐ: 'セ',
      ㅑ: 'シャ',
      ㅓ: 'ソ',
      ㅔ: 'セ',
      ㅕ: 'ショ',
      ㅗ: 'ソ',
      ㅘ: 'スァ',
      ㅙ: 'スェ',
      ㅚ: 'スェ',
      ㅛ: 'ショ',
      ㅜ: 'ス',
      ㅝ: 'スォ',
      ㅞ: 'スェ',
      ㅟ: 'スィ',
      ㅠ: 'シュ',
      ㅡ: 'ス',
      ㅢ: 'スィ',
      ㅣ: 'シ',
    },
    ㅆ: {
      ㅏ: 'ッサ',
      ㅐ: 'ッセ',
      ㅑ: 'ッシャ',
      ㅓ: 'ッソ',
      ㅔ: 'ッセ',
      ㅕ: 'ッショ',
      ㅗ: 'ッソ',
      ㅘ: 'ッスァ',
      ㅙ: 'ッスェ',
      ㅚ: 'ッスェ',
      ㅛ: 'ッショ',
      ㅜ: 'ッス',
      ㅝ: 'ッスォ',
      ㅞ: 'ッスェ',
      ㅟ: 'ッスィ',
      ㅠ: 'ッシュ',
      ㅡ: 'ッス',
      ㅢ: 'ッスィ',
      ㅣ: 'ッシ',
    },
    ㅈ: {
      ㅏ: 'チャ',
      ㅐ: 'チェ',
      ㅑ: 'チャ',
      ㅓ: 'チョ',
      ㅔ: 'チェ',
      ㅕ: 'チョ',
      ㅗ: 'チョ',
      ㅘ: 'チョァ',
      ㅙ: 'チェ',
      ㅚ: 'チェ',
      ㅛ: 'チョ',
      ㅜ: 'チュ',
      ㅝ: 'チョ',
      ㅞ: 'チェ',
      ㅟ: 'チュィ',
      ㅠ: 'チュ',
      ㅡ: 'チュ',
      ㅢ: 'チ',
      ㅣ: 'チ',
    },
    ㅉ: {
      ㅏ: 'ッチャ',
      ㅐ: 'ッチェ',
      ㅑ: 'ッチャ',
      ㅓ: 'ッチョ',
      ㅔ: 'ッチェ',
      ㅕ: 'ッチョ',
      ㅗ: 'ッチョ',
      ㅘ: 'ッチョァ',
      ㅙ: 'ッチェ',
      ㅚ: 'ッチェ',
      ㅛ: 'ッチョ',
      ㅜ: 'ッチュ',
      ㅝ: 'ッチョ',
      ㅞ: 'ッチェ',
      ㅟ: 'ッチュィ',
      ㅠ: 'ッチュ',
      ㅡ: 'ッチュ',
      ㅢ: 'ッチ',
      ㅣ: 'ッチ',
    },
    ㅊ: {
      ㅏ: 'チャ',
      ㅐ: 'チェ',
      ㅑ: 'チャ',
      ㅓ: 'チョ',
      ㅔ: 'チェ',
      ㅕ: 'チョ',
      ㅗ: 'チョ',
      ㅘ: 'チョァ',
      ㅙ: 'チェ',
      ㅚ: 'チェ',
      ㅛ: 'チョ',
      ㅜ: 'チュ',
      ㅝ: 'チョ',
      ㅞ: 'チェ',
      ㅟ: 'チュィ',
      ㅠ: 'チュ',
      ㅡ: 'チュ',
      ㅢ: 'チ',
      ㅣ: 'チ',
    },
    ㅋ: {
      ㅏ: 'カ',
      ㅐ: 'ケ',
      ㅑ: 'キャ',
      ㅓ: 'コ',
      ㅔ: 'ケ',
      ㅕ: 'キョ',
      ㅗ: 'コ',
      ㅘ: 'クァ',
      ㅙ: 'クェ',
      ㅚ: 'クェ',
      ㅛ: 'キョ',
      ㅜ: 'ク',
      ㅝ: 'クォ',
      ㅞ: 'クェ',
      ㅟ: 'クィ',
      ㅠ: 'キュ',
      ㅡ: 'ク',
      ㅢ: 'クィ',
      ㅣ: 'キ',
    },
    ㅌ: {
      ㅏ: 'タ',
      ㅐ: 'テ',
      ㅑ: 'チャ',
      ㅓ: 'ト',
      ㅔ: 'テ',
      ㅕ: 'チョ',
      ㅗ: 'ト',
      ㅘ: 'トゥァ',
      ㅙ: 'トゥェ',
      ㅚ: 'トェ',
      ㅛ: 'チョ',
      ㅜ: 'トゥ',
      ㅝ: 'トゥォ',
      ㅞ: 'トゥェ',
      ㅟ: 'ティ',
      ㅠ: 'テュ',
      ㅡ: 'トゥ',
      ㅢ: 'ティ',
      ㅣ: 'ティ',
    },
    ㅍ: {
      ㅏ: 'パ',
      ㅐ: 'ペ',
      ㅑ: 'ピャ',
      ㅓ: 'ポ',
      ㅔ: 'ペ',
      ㅕ: 'ピョ',
      ㅗ: 'ポ',
      ㅘ: 'プァ',
      ㅙ: 'プェ',
      ㅚ: 'プェ',
      ㅛ: 'ピョ',
      ㅜ: 'プ',
      ㅝ: 'プォ',
      ㅞ: 'プェ',
      ㅟ: 'プィ',
      ㅠ: 'ピュ',
      ㅡ: 'プ',
      ㅢ: 'プィ',
      ㅣ: 'ピ',
    },
    ㅎ: {
      ㅏ: 'ハ',
      ㅐ: 'ヘ',
      ㅑ: 'ヒャ',
      ㅓ: 'ホ',
      ㅔ: 'ヘ',
      ㅕ: 'ヒョ',
      ㅗ: 'ホ',
      ㅘ: 'ファ',
      ㅙ: 'フェ',
      ㅚ: 'フェ',
      ㅛ: 'ヒョ',
      ㅜ: 'フ',
      ㅝ: 'フォ',
      ㅞ: 'フェ',
      ㅟ: 'フィ',
      ㅠ: 'ヒュ',
      ㅡ: 'フ',
      ㅢ: 'フィ',
      ㅣ: 'ヒ',
    },
  }

  return TABLE[cho]?.[jung] ?? VOWEL_BASE[jung] ?? 'ア'
}

/** 받침(종성)을 일본어 가타카나로 변환 */
function finalToKana(jong: string, nextCho?: string): string {
  if (!jong || jong === '') return ''

  // ㄴ, ㅁ, ㅇ 받침은 일본어 'ン'으로 자연스럽게 연결
  if (jong === 'ㄴ' || jong === 'ㅁ' || jong === 'ㅇ') {
    return 'ン'
  }

  // ㄹ 받침은 'ル'
  if (jong === 'ㄹ') {
    return 'ル'
  }

  // 뒷 음절이 있는 경우 받침 ㄱ, ㄷ, ㅂ, ㅅ 등은 촉음(ッ)으로 자연스럽게 축약
  if (nextCho && nextCho !== 'ㅇ' && nextCho !== '') {
    if (
      [
        'ㄱ',
        'ㄲ',
        'ㅋ',
        'ㅅ',
        'ㅆ',
        'ㄷ',
        'ㅌ',
        'ㅈ',
        'ㅊ',
        'ㅂ',
        'ㅍ',
      ].includes(jong)
    ) {
      return 'ッ'
    }
  }

  // 단어 끝이나 단독 받침일 때의 종성 발음
  const ENDING_MAP: Record<string, string> = {
    ㄱ: 'ク',
    ㄲ: 'ク',
    ㄳ: 'ク',
    ㄷ: 'ッ',
    ㅌ: 'ッ',
    ㅅ: 'ッ',
    ㅆ: 'ッ',
    ㅈ: 'ッ',
    ㅊ: 'ッ',
    ㅎ: '',
    ㅂ: 'プ',
    ㅍ: 'プ',
    ㅄ: 'プ',
    ㄺ: 'ルク',
    ㄻ: 'ルム',
    ㄼ: 'ル',
    ㄽ: 'ル',
    ㄾ: 'ル',
    ㄿ: 'ルプ',
    ㅀ: 'ル',
    ㄵ: 'ン',
    ㄶ: 'ン',
  }

  return ENDING_MAP[jong] ?? ''
}

/**
 * 한국어 텍스트 전체를 VOICEVOX용 최적화 가타카나 음소열로 변환합니다.
 * 한글이 아닌 문자(일본어, 영어, 숫자, 문장부호)는 그대로 유지합니다.
 */
export function koreanToVoicevoxKana(text: string): string {
  // 자주 쓰이는 한국어 단어 사전 (특수 발음 최적화)
  const SPECIAL_WORDS: Record<string, string> = {
    안녕: 'アンニョン',
    안녕하세요: 'アンニョンハセヨ',
    반가워: 'パンガウォ',
    반갑습니다: 'パンガップスムニダ',
    고마워: 'コマウォ',
    감사합니다: 'カムサハムニダ',
    죄송합니다: 'チェソンハムニダ',
    미안해: 'ミアンヘ',
    좋아: 'チョア',
    싫어: 'シロ',
    맞아: 'マジャ',
    아니: 'アニ',
    응: 'ウン',
    어: 'オ',
    그래: 'クレ',
    진짜: 'チンチャ',
    정말: 'チョンマル',
    대박: 'テバク',
    화이팅: 'ファイティン',
    파이팅: 'ファイティン',
    리시: 'リシ',
    리시봇: 'リシボッ',
    리스: 'リス',
    디스코드: 'ディスコード',
  }

  let processed = text
  for (const [kr, kana] of Object.entries(SPECIAL_WORDS)) {
    processed = processed.replace(new RegExp(kr, 'gu'), kana)
  }

  let result = ''
  let hangulBuffer: Syllable[] = []

  const flushBuffer = () => {
    if (hangulBuffer.length === 0) return
    const transformed = applyPhonologicalRules(hangulBuffer)
    for (let i = 0; i < transformed.length; i++) {
      const syl = transformed[i]
      if (!syl) continue
      const nextCho = transformed[i + 1]?.cho
      const baseKana = syllableToKana(syl.cho, syl.jung)
      const jongKana = finalToKana(syl.jong, nextCho)
      result += `${baseKana}${jongKana}`
    }
    hangulBuffer = []
  }

  for (const char of processed) {
    const syllable = decomposeHangul(char)
    if (syllable !== null) {
      hangulBuffer.push(syllable)
    } else {
      flushBuffer()
      result += char
    }
  }

  flushBuffer()
  return result
}
