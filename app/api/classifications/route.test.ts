import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

const dbMock = vi.hoisted(() => ({
  getClassificationList: vi.fn(),
  getClassificationTree: vi.fn(),
  initializeDatabase: vi.fn(),
}))

vi.mock('@/lib/db', () => dbMock)

function request(url: string): NextRequest {
  return {
    nextUrl: new URL(url),
  } as unknown as NextRequest
}

describe('classification dictionary route', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(dbMock)) mock.mockReset()
    dbMock.initializeDatabase.mockResolvedValue(undefined)
    dbMock.getClassificationList.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
      total_pages: 0,
    })
    dbMock.getClassificationTree.mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      parent_code_norm: null,
      is_search: false,
    })
  })

  it('rejects unsupported classification types', async () => {
    const { GET } = await import('./route')
    const response = await GET(
      request('http://localhost/api/classifications?type=bad'),
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toEqual({
      success: false,
      error: '分类类型必须是 ipc 或 cpc',
    })
    expect(dbMock.initializeDatabase).not.toHaveBeenCalled()
    expect(dbMock.getClassificationList).not.toHaveBeenCalled()
  })

  it('returns classification pagination data for valid requests', async () => {
    dbMock.getClassificationList.mockResolvedValue({
      items: [
        {
          code_norm: 'H01M',
          code: 'H01M',
          source_code: 'H01M',
          version: '2026.01',
          section: 'H',
          class_code: 'H01',
          subclass: 'H01M',
          main_group: null,
          subgroup: null,
          level: null,
          title_en: 'Processes or means',
          title_zh: null,
          title_zh_source: null,
          source_file: 'ipc.txt',
        },
      ],
      total: 1,
      page: 2,
      limit: 10,
      total_pages: 1,
    })

    const { GET } = await import('./route')
    const response = await GET(
      request(
        'http://localhost/api/classifications?type=ipc&q=H01M&page=2&limit=10',
      ),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.items[0].code_norm).toBe('H01M')
    expect(dbMock.initializeDatabase).toHaveBeenCalled()
    expect(dbMock.getClassificationList).toHaveBeenCalledWith(
      { type: 'ipc', q: 'H01M' },
      2,
      10,
    )
  })

  it('caps the request limit and returns a generic database error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    dbMock.getClassificationList.mockRejectedValue(
      new Error('postgresql://user:secret@host/db failed'),
    )

    const { GET } = await import('./route')
    const response = await GET(
      request('http://localhost/api/classifications?type=cpc&limit=1000'),
    )
    const body = await response.json()

    expect(dbMock.getClassificationList).toHaveBeenCalledWith(
      { type: 'cpc', q: undefined },
      1,
      100,
    )
    expect(response.status).toBe(500)
    expect(body).toEqual({
      success: false,
      error: '分类字典查询失败，请检查数据库连接后重试',
    })

    consoleError.mockRestore()
  })

  it('returns tree data with an optional parent node', async () => {
    dbMock.getClassificationTree.mockResolvedValue({
      items: [
        {
          code_norm: 'H01',
          code: 'H01',
          source_code: 'H01',
          version: '2026.01',
          section: 'H',
          class_code: 'H01',
          subclass: null,
          main_group: null,
          subgroup: null,
          level: null,
          title_en: 'Basic electric elements',
          title_zh: null,
          title_zh_source: null,
          source_file: 'ipc.txt',
          parent_code_norm: 'H',
          depth: 1,
          has_children: true,
          is_match: false,
        },
      ],
      total: 1,
      limit: 50,
      parent_code_norm: 'H',
      is_search: false,
    })

    const { GET } = await import('./route')
    const response = await GET(
      request(
        'http://localhost/api/classifications?type=ipc&view=tree&parent=H&limit=50',
      ),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.items[0].parent_code_norm).toBe('H')
    expect(dbMock.getClassificationList).not.toHaveBeenCalled()
    expect(dbMock.getClassificationTree).toHaveBeenCalledWith(
      { type: 'ipc', q: undefined },
      'H',
      50,
    )
  })
})
