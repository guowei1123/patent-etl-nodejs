import { createHash } from 'node:crypto'
import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importPdfManifest } from '../pdf/historical-pdf-import'

const content = Buffer.from('verified image')
const manifest = {
  version: 'pdf-pages-v1',
  batch: 'PDF-TEST',
  patent_number: 'CN1577321A',
  pdf_hash: 'a'.repeat(64),
  source: 'source.tar::CN1577321A.pdf',
  images: [
    {
      file_name: 'CN1577321A_drawing_001.png',
      page: 25,
      width: 2000,
      height: 3000,
      content_hash: createHash('sha256').update(content).digest('hex'),
      figure_label: '附图第 1 页',
    },
  ],
}
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))
import { readFile } from 'node:fs/promises'

function database(existing = false) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('historical_pdf_image h'))
      return {
        rowCount: existing ? 1 : 0,
        rows: existing ? [{ id: 'image' }] : [],
      }
    return { rowCount: 1, rows: [{ id: 'record' }] }
  })
  const release = vi.fn()
  const pool = {
    query: vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ id: 'patent', app_number: null }],
    }),
    connect: vi.fn().mockResolvedValue({ query, release }),
  }
  return { pool, query, release }
}

beforeEach(() => {
  vi.mocked(readFile).mockImplementation(async (_file, encoding) =>
    encoding ? JSON.stringify(manifest) : content,
  )
})

describe('PDF 附图入库事务', () => {
  it('预览不创建事务、不上传，并按完整版本匹配', async () => {
    const db = database()
    const upload = vi.fn()
    const result = await importPdfManifest(
      'manifest.json',
      'PDF-TEST',
      false,
      db.pool as unknown as pg.Pool,
      upload,
    )
    expect(result.status).toBe('ready')
    expect(db.pool.query.mock.calls[0][1]).toEqual([
      ['1577321', 'CN1577321', 'CN1577321A'],
      'A',
    ])
    expect(db.pool.connect).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })
  it('已有授权记录则跳过申请图片', async () => {
    const db = database()
    db.pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'patent', app_number: '200410058724.8' }],
    })
    const upload = vi.fn()
    expect(
      (
        await importPdfManifest(
          'manifest.json',
          'PDF-TEST',
          true,
          db.pool as unknown as pg.Pool,
          upload,
        )
      ).status,
    ).toBe('superseded')
    expect(upload).not.toHaveBeenCalled()
  })
  it('重复导入不重复上传或创建图片关联', async () => {
    const db = database(true)
    const upload = vi.fn()
    await importPdfManifest(
      'manifest.json',
      'PDF-TEST',
      true,
      db.pool as unknown as pg.Pool,
      upload,
    )
    expect(upload).not.toHaveBeenCalled()
    expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(
      false,
    )
    expect(db.query).toHaveBeenCalledWith('COMMIT')
    expect(db.release).toHaveBeenCalled()
  })
  it('上传失败回滚，不写入图片关联', async () => {
    const db = database()
    const upload = vi.fn().mockRejectedValue(new Error('upload failed'))
    await expect(
      importPdfManifest(
        'manifest.json',
        'PDF-TEST',
        true,
        db.pool as unknown as pg.Pool,
        upload,
      ),
    ).rejects.toThrow('upload failed')
    expect(db.query).toHaveBeenCalledWith('ROLLBACK')
    expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(
      false,
    )
    expect(db.release).toHaveBeenCalled()
  })
  it('成功后写入资产、关联及来源，不删除 FTP 图片', async () => {
    const db = database()
    await importPdfManifest(
      'manifest.json',
      'PDF-TEST',
      true,
      db.pool as unknown as pg.Pool,
      vi.fn(),
    )
    expect(
      db.query.mock.calls.filter(([sql]) => sql.includes('INSERT')),
    ).toHaveLength(3)
    expect(db.query.mock.calls.some(([sql]) => sql.includes('DELETE'))).toBe(
      false,
    )
    expect(db.query).toHaveBeenCalledWith('COMMIT')
  })
})
