import { describe, expect, it } from 'vitest'
import {
  parsePublicationNumber,
  validateManifest,
  type PdfManifest,
} from '../pdf/historical-pdf'

function manifest(): PdfManifest {
  return {
    version: 'pdf-pages-v1',
    batch: 'PDF-TEST',
    patent_number: 'CN1577321A',
    pdf_hash: 'a'.repeat(64),
    source: 'archive.tar::CN1577321A.pdf',
    images: [
      {
        file_name: 'CN1577321A_drawing_001.png',
        page: 8,
        width: 2000,
        height: 3000,
        content_hash: 'b'.repeat(64),
        figure_label: '附图第 1 页',
      },
    ],
  }
}

describe('历史 PDF 导入边界', () => {
  it('保留申请与授权种类码，避免跨版本关联', () => {
    expect(parsePublicationNumber('CN1577321A')).toEqual({
      number: '1577321',
      kind: 'A',
    })
    expect(parsePublicationNumber('CN1577321B')).toEqual({
      number: '1577321',
      kind: 'B',
    })
    expect(() => parsePublicationNumber('1577321')).toThrow()
  })
  it('阻止清单越过所属批次', () => {
    expect(() => validateManifest(manifest(), 'OTHER')).toThrow()
  })
  it('阻止图片文件路径逃逸', () => {
    const value = manifest()
    value.images[0].file_name = '../secret.png'
    expect(() => validateManifest(value, value.batch)).toThrow()
  })
  it('接受原文图名文件并校验公告日期', () => {
    const value = manifest()
    value.version = 'pdf-figures-v2'
    value.publication_date = '2008-01-02'
    value.images[0].file_name = '说明书-图1A.png'
    expect(() => validateManifest(value, value.batch)).not.toThrow()
    value.images[0].file_name = '摘要-图1.png'
    expect(() => validateManifest(value, value.batch)).not.toThrow()
    value.images[0].file_name = '说明书-../图1A.png'
    expect(() => validateManifest(value, value.batch)).toThrow()
    value.images[0].file_name = '说明书-图1A.png'
    value.publication_date = '2008-02-30'
    expect(() => validateManifest(value, value.batch)).toThrow()
  })
  it('阻止重复页码或损坏哈希写入', () => {
    const value = manifest()
    value.images.push({ ...value.images[0] })
    expect(() => validateManifest(value, value.batch)).toThrow()
    value.images.pop()
    value.images[0].content_hash = 'broken'
    expect(() => validateManifest(value, value.batch)).toThrow()
  })
})
