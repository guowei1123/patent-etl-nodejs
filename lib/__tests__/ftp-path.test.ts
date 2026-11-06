import { describe, expect, it } from 'vitest'
import { formatFtpPath, normalizeFtpDirectoryName } from '../ftp-path'

const sourceName = 'CN-PA-TXTS-10-B_中国发明专利授权公告标准化全文文本数据'
const mojibake = (text: string) => Buffer.from(text, 'utf8').toString('latin1')

describe('FTP path display', () => {
  it('displays the Chinese name without changing the stored transport path', () => {
    const batch = { ftp_folder: `/CN/${mojibake(sourceName)}/data/20241001` }
    const original = batch.ftp_folder
    expect(formatFtpPath(batch.ftp_folder)).toBe(`/CN/${sourceName}/data/20241001`)
    expect(batch.ftp_folder).toBe(original)
  })

  it('decodes path segments independently, including mixed and twice encoded names', () => {
    expect(formatFtpPath(`/中文/${mojibake(mojibake(sourceName))}/data/`)).toBe(
      `/中文/${sourceName}/data/`,
    )
  })

  it('preserves valid names, incomplete encodings and path delimiters', () => {
    for (const value of ['', '/', '//CN/data/', '../data/20241001', sourceName, 'café', '????', 'ä¸', '%E4%B8%AD']) {
      expect(formatFtpPath(value)).toBe(value)
    }
    expect(normalizeFtpDirectoryName('\u00ef\u00bb\u00bf')).toBe('\ufeff')
  })

  it('uses browser APIs without requiring Buffer at runtime', () => {
    const encoded = mojibake(sourceName)
    const originalBuffer = globalThis.Buffer
    try {
      // @ts-expect-error 模拟浏览器中没有 Node.js Buffer。
      globalThis.Buffer = undefined
      expect(normalizeFtpDirectoryName(encoded)).toBe(sourceName)
    } finally {
      globalThis.Buffer = originalBuffer
    }
  })
})
