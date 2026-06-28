import { EmbedBuilder } from 'discord.js'

const BOOST_MESSAGES: readonly string[] = [
  '🚀 {mention}님이 서버를 부스트했습니다! 덕분에 서버가 한 단계 더 성장했어요. 진심으로 감사드립니다! 💜',
  '⚡ 와! {mention}님의 부스트가 도착했습니다! 서버를 위해 소중한 지원을 해주셔서 정말 감사해요 🙌',
  '🌟 {mention}님, 서버 부스트 감사합니다! 당신 덕분에 우리 서버가 더욱 빛나고 있어요 ✨',
  '💎 {mention}님이 서버를 부스트해주셨습니다! 최고의 멤버에게 최고의 감사를 드립니다 👑',
  '🎊 붐! {mention}님의 부스트 폭탄이 터졌습니다! 서버 발전에 함께해 주셔서 너무 감사해요 💜',
  '🦋 {mention}님, 부스트해주셔서 감사합니다! 당신의 따뜻한 마음이 서버를 더 특별하게 만들어줍니다 🫶',
  '🔥 {mention}님이 서버에 불을 질렀습니다... 부스트로요! 엄청난 서포트 정말 감사드립니다 🎉',
  '🎯 {mention}님이 부스트를 선물해주셨어요! 서버의 든든한 버림목이 되어주셔서 감사합니다 💪',
  '💫 {mention}님, 서버 부스트 완료! 이 서버가 더 좋은 공간이 될 수 있도록 함께해 주셔서 감사해요 🌈',
  '🎁 특별한 선물이 도착했어요! {mention}님이 서버를 부스트해주셨습니다. 우리 서버의 MVP입니다 🏆',
]

export function pickRandomBoostMessage(mention: string): string {
  const idx = Math.floor(Math.random() * BOOST_MESSAGES.length)
  return BOOST_MESSAGES[idx].replaceAll('{mention}', mention)
}

export function buildBoostEmbed(mention: string): EmbedBuilder {
  const message = pickRandomBoostMessage(mention)
  return new EmbedBuilder()
    .setTitle('💜 서버 부스트 감사합니다!')
    .setDescription(message)
    .setColor(0x9b59b6)
    .setFooter({ text: 'FullMoon · 리시' })
    .setTimestamp()
}

export function buildBoostTierUpEmbed(
  mention: string,
  tier: number
): EmbedBuilder {
  const message = pickRandomBoostMessage(mention)
  return new EmbedBuilder()
    .setTitle(`💜 서버 부스트 레벨 ${tier} 달성!`)
    .setDescription(message)
    .setColor(0x9b59b6)
    .setFooter({ text: `FullMoon · 리시 · 부스트 레벨 ${tier}` })
    .setTimestamp()
}
