import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { guardHistoricalBatch } from '../guards'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../../lib/db', () => ({ getPool: async () => ({ query }) }))

describe('历史批次隔离', () => {
  beforeEach(() => {
    query.mockReset()
  })
  it('阻止 FTP 操作但不消耗请求正文', async () => {
    const request = new NextRequest('http://localhost/api/sync/step', {
      method: 'POST',
      body: JSON.stringify({ batch_code: 'HIST-20080101-B' }),
    })
    expect((await guardHistoricalBatch(request))?.status).toBe(400)
    expect((await request.json()).batch_code).toBe('HIST-20080101-B')
  })
  it('阻止从 FTP 批次删除接口级联删除历史专利', async () => {
    expect(
      (
        await guardHistoricalBatch(
          new NextRequest('http://localhost/api/batches/HIST-20080101-B', {
            method: 'DELETE',
          }),
        )
      )?.status,
    ).toBe(400)
  })
  it('保留现有 FTP 请求行为', async () => {
    expect(
      await guardHistoricalBatch(
        new NextRequest('http://localhost/api/sync/step', {
          method: 'POST',
          body: JSON.stringify({ batch_code: 'FTP-001' }),
        }),
      ),
    ).toBeNull()
  })
  it.each(['10-A', '10-B', '20-U'])(
    '按来源保护 %s 历史批次并保留请求正文',
    async (type) => {
      query.mockResolvedValueOnce({ rows: [{ ftp_folder: null }] })
      const code = `CN-PA-TXTS-${type}-20080101`
      const request = new NextRequest('http://localhost/api/sync/step', {
        method: 'POST',
        body: JSON.stringify({ batch_code: code }),
      })
      expect((await guardHistoricalBatch(request))?.status).toBe(400)
      expect((await request.json()).batch_code).toBe(code)
    },
  )
  it('保护同名 FTP 与历史混合批次', async () => {
    query.mockResolvedValueOnce({
      rows: [{ ftp_folder: '/发明授权/20080101' }],
    })
    query.mockResolvedValueOnce({
      rows: [{ source: 'cnipa.history_import_source' }],
    })
    query.mockResolvedValueOnce({ rows: [{ found: 1 }] })
    const request = new NextRequest(
      'http://localhost/api/batches/CN-PA-TXTS-10-B-20080101',
      { method: 'DELETE' },
    )
    expect((await guardHistoricalBatch(request))?.status).toBe(400)
  })
  it('允许没有历史来源的正常 FTP 批次', async () => {
    query.mockResolvedValueOnce({
      rows: [{ ftp_folder: '/发明授权/20080101' }],
    })
    query.mockResolvedValueOnce({
      rows: [{ source: 'cnipa.history_import_source' }],
    })
    query.mockResolvedValueOnce({ rows: [] })
    const request = new NextRequest('http://localhost/api/sync/step', {
      method: 'POST',
      body: JSON.stringify({ batch_code: 'CN-PA-TXTS-10-B-20080101' }),
    })
    expect(await guardHistoricalBatch(request)).toBeNull()
  })
  it('按 FTP 路径生成批次时仍保护已有历史数据', async () => {
    query.mockResolvedValueOnce({ rows: [{ ftp_folder: null }] })
    const request = new NextRequest('http://localhost/api/sync/start', {
      method: 'POST',
      body: JSON.stringify({
        data_type: 'invention',
        ftp_folder: '/发明授权/20080101',
      }),
    })
    expect((await guardHistoricalBatch(request))?.status).toBe(400)
    expect(query.mock.calls[0][1]).toEqual(['CN-PA-TXTS-10-B-20080101'])
  })
  it('批次来源核对失败时拒绝变更，不泄露数据库错误', async () => {
    query.mockRejectedValueOnce(new Error('private connection details'))
    const request = new NextRequest(
      'http://localhost/api/batches/CN-PA-TXTS-20-U-20080101',
      { method: 'DELETE' },
    )
    const response = await guardHistoricalBatch(request)
    expect(response?.status).toBe(503)
    expect(await response?.text()).not.toContain('private')
  })
})
