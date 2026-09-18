import { logger } from '../utils/logger'
import { execFile } from 'child_process'
import ffmpegPath from 'ffmpeg-static'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// amix의 자동 정규화(입력 수만큼 감쇠)를 끄고 명시적 볼륨을 쓴다.
// 음성을 살짝 줄여 효과음이 묻히지 않게 한다.
const SPEECH_VOLUME = 0.75
const BG_VOLUME = 0.5
const MIX_TIMEOUT_MS = 15_000

// 배경 효과음을 말소리 밑에 깔아 하나의 오디오로 합성한다.
// loop=true(환경음)면 말소리 길이에 맞춰 배경이 루프되고,
// loop=false(단발음)면 시작에 한 번만 재생된다. 말이 끝나면 함께 끝난다.
export async function mixSpeechWithBackground(
  speech: Buffer,
  background: Buffer,
  loop = true
): Promise<Buffer | null> {
  if (ffmpegPath === null) {
    logger.warn('TTS', 'ffmpeg 바이너리 없음 - 믹싱 스킵')
    return null
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'tts-mix-'))
  const speechPath = path.join(dir, 'speech.mp3')
  const bgPath = path.join(dir, 'bg.mp3')
  const outPath = path.join(dir, 'out.mp3')

  try {
    writeFileSync(speechPath, speech)
    writeFileSync(bgPath, background)

    const bgInputArgs = loop
      ? ['-stream_loop', '-1', '-i', bgPath]
      : ['-i', bgPath]

    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpegPath as string,
        [
          '-y',
          '-i',
          speechPath,
          ...bgInputArgs,
          '-filter_complex',
          `[0:a]volume=${SPEECH_VOLUME}[sp];[1:a]volume=${BG_VOLUME}[bg];[sp][bg]amix=inputs=2:duration=first:dropout_transition=2:normalize=0`,
          '-codec:a',
          'libmp3lame',
          '-b:a',
          '128k',
          outPath,
        ],
        { timeout: MIX_TIMEOUT_MS },
        (err) => (err !== null ? reject(err) : resolve())
      )
    })

    return readFileSync(outPath)
  } catch (err) {
    logger.warn(
      'TTS',
      `오디오 믹싱 실패: ${err instanceof Error ? err.message : String(err)}`
    )
    return null
  } finally {
    try {
      rmSync(dir, { force: true, recursive: true })
    } catch {
      // 임시 파일 정리 실패는 무시
    }
  }
}
