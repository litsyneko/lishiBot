import type { Message } from 'discord.js'

const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif)$/i

/** Discord 첨부 중 모델에 전달할 수 있는 이미지만 고른다. */
export function getMessageImageUrls(message: Message): string[] {
  return [...message.attachments.values()]
    .filter((attachment) => {
      if (attachment.size > MAX_IMAGE_BYTES) return false
      const mime = attachment.contentType?.split(';', 1)[0].toLowerCase()
      if (mime !== undefined && mime !== 'application/octet-stream') {
        return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
          mime
        )
      }
      return IMAGE_EXTENSION.test(attachment.name ?? '')
    })
    .slice(0, MAX_IMAGES)
    .map((attachment) => attachment.url)
}
