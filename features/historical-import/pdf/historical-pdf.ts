import { createHash } from 'node:crypto'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

export interface PdfManifest {
  version: string
  publication_date?: string | null
  announcement_batch?: string | null
  date_source?: string | null
  date_status?: string
  batch: string
  patent_number: string
  pdf_hash: string
  source: string
  images: Array<{
    file_name: string
    page: number
    width: number
    height: number
    content_hash: string
    figure_label: string
    image_role?: 'abstract' | 'drawing' | 'body_figure' | 'table' | 'formula'
    bbox?: number[]
    extraction_method?: string
  }>
}

export function parsePublicationNumber(value: string) {
  const match = /^CN(\d{7,12})([ABCUSY]\d?)$/.exec(value)
  if (!match) throw new Error('公开号必须包含 CN、数字及文献种类码')
  return { number: match[1], kind: match[2] }
}

export function validateManifest(value: PdfManifest, batch: string) {
  parsePublicationNumber(value.patent_number)
  if (
    value.batch !== batch ||
    !/^[a-f0-9]{64}$/.test(value.pdf_hash) ||
    !['pdf-pages-v1', 'pdf-figures-v2'].includes(value.version) ||
    typeof value.source !== 'string'
  ) {
    throw new Error('清单批次、版本或 PDF 哈希无效')
  }
  if (!Array.isArray(value.images) || !value.images.length)
    throw new Error('清单没有附图')
  if (value.publication_date && (
    !/^\d{4}-\d{2}-\d{2}$/.test(value.publication_date) ||
    Number.isNaN(Date.parse(value.publication_date)) ||
    new Date(value.publication_date).toISOString().slice(0, 10) !== value.publication_date
  )) throw new Error('PDF 公告日期无效')
  const pages = new Set<number>()
  const names = new Set<string>()
  for (const image of value.images) {
    if (
      !(new RegExp(
        `^${value.patent_number}_(drawing|abstract|body_figure|table|formula)_\\d{3,}\\.png$`,
      ).test(image.file_name) || /^(摘要|说明书)-[^<>:"/\\|?*\x00-\x1f]+\.png$/u.test(image.file_name)) ||
      !Number.isInteger(image.page) ||
      names.has(image.file_name) ||
      image.page < 1 ||
      (value.version === 'pdf-pages-v1' && pages.has(image.page)) ||
      (image.image_role !== undefined &&
        !['abstract', 'drawing', 'body_figure', 'table', 'formula'].includes(
          image.image_role,
        )) ||
      !Number.isInteger(image.width) ||
      image.width < 1 ||
      !Number.isInteger(image.height) ||
      image.height < 1 ||
      !/^[a-f0-9]{64}$/.test(image.content_hash) ||
      typeof image.figure_label !== 'string'
    ) {
      throw new Error('附图文件名、页码、尺寸或哈希无效')
    }
    pages.add(image.page)
    names.add(image.file_name)
  }
}

export async function readVerifiedImage(
  directory: string,
  image: PdfManifest['images'][number],
) {
  const content = await readFile(path.join(directory, image.file_name))
  if (
    createHash('sha256').update(content).digest('hex') !== image.content_hash
  ) {
    throw new Error('图片哈希校验失败，请重新提取')
  }
  return content
}
