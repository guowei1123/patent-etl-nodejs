import type { PatentType } from '@/types'

export function generateBatchCode(
  dataType: PatentType | string,
  ftpFolder: string,
): string {
  const prefix =
    dataType === 'invention' ? 'CN-PA-TXTS-10-B' : 'CN-PA-TXTS-20-U'
  const folderName = ftpFolder.split('/').filter(Boolean).pop() || ''
  const match = folderName.match(/^(\d{8})(rawdata)?$/i)
  if (match) {
    const date = match[1]
    const suffix = match[2] ? '-Raw' : ''
    return `${prefix}-${date}${suffix}`
  }
  return `${prefix}-${folderName}`
}
