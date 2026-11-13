import { buildPatentImageKey } from '../../../lib/oss-client.ts'
import { parsePublicationNumber } from './historical-pdf.ts'

export function repairImageKey(batch: string, publication: string, hash: string, order: number) {
  const { number } = parsePublicationNumber(publication)
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('图片哈希无效')
  if (!Number.isInteger(order) || order < 1) throw new Error('图片顺序无效')
  return buildPatentImageKey(batch, number, `FT_${order}.jpg`)
}

export function legacyRepairImageKey(batch: string, publication: string, hash: string, order: number) {
  const { number, kind } = parsePublicationNumber(publication)
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('图片哈希无效')
  if (!Number.isInteger(order) || order < 1) throw new Error('图片顺序无效')
  return buildPatentImageKey(batch, number, `FT_${order}-${kind}-${hash}.png`)
}
