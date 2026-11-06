import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { publishRecord } from '../publish'
import { configSchema, announcementBatch, type ImportRecord } from '../model'

function record(): ImportRecord {
  return {
    publication: 'CN1577321B',
    application: 'CN2004100587248',
    kind: 'B',
    date: '2008-01-01',
    title: '授权版',
    abstract: '',
    applicant: '',
    inventor: '',
    ipc: '',
    grant: 'CN1577321B',
    grantDate: '2008-01-01',
    description: '授权说明书',
    claims: '授权权利要求',
    raw: {},
    source: 'metadata.xlsx::row=3',
    status: 'ready',
    reasons: [],
  }
}
const config = configSchema.parse({
  excelPath: 'input.xlsx',
  descriptionPath: 'description.parquet',
  claimsPath: 'claims.parquet',
  pdfPath: 'pdf',
  columns: {},
  noDrawingNumbers: ['CN1577321B', 'CN1577321A'],
})
function database(failInsert = false, granted = false) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('AS complete'))
      return { rows: [{ complete: true }], rowCount: 1 }
    if (sql.includes('LEFT JOIN cnipa.history_import_source'))
      return { rows: [], rowCount: 0 }
    if (sql.includes("kind ~ '^[BC]'"))
      return {
        rows: granted ? [{ id: 'grant' }] : [],
        rowCount: granted ? 1 : 0,
      }
    if (sql.includes("kind ~ '^A'"))
      return { rows: [{ id: 'application' }], rowCount: 1 }
    if (failInsert && sql.includes('INSERT INTO cnipa.patent'))
      throw new Error('database failure')
    return { rows: [{ id: 'grant' }], rowCount: 1 }
  })
  const release = vi.fn()
  return {
    pool: {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as pg.Pool,
    query,
    release,
    calls,
  }
}
describe('历史专利版本发布', () => {
  it('说明书补入阶段保留既有权利要求和基础字段', async () => {
    const db = database()
    const original = db.query.getMockImplementation()!
    db.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      const result = await original(sql, values)
      if (sql.includes('LEFT JOIN cnipa.history_import_source'))
        return { rows: [{ id: 'grant' }], rowCount: 1 }
      if (sql.includes('AS complete'))
        return { rows: [{ complete: false }], rowCount: 1 }
      return result
    })
    await publishRecord(
      db.pool,
      { ...record(), description: '补入说明书', claims: '' },
      { ...config, stage: 'text', claimsPath: '' },
      'job',
      vi.fn(),
    )
    const update = db.calls.find((call) =>
      call.sql.includes('description=COALESCE($2::jsonb'),
    )!
    expect(update.values).toEqual([
      'grant',
      JSON.stringify({ embodiment: '补入说明书' }),
      null,
    ])
    expect(db.calls.some((call) => call.sql.includes('SET title='))).toBe(false)
  })
  it('基础信息阶段不要求附图，不覆盖正文，未补齐时保留申请记录', async () => {
    const db = database()
    const original = db.query.getMockImplementation()!
    db.query.mockImplementation(async (sql: string, values?: unknown[]) =>
      sql.includes('AS complete')
        ? { rows: [{ complete: false }], rowCount: 1 }
        : original(sql, values),
    )
    const source = { ...record(), description: '', claims: '' }
    await publishRecord(
      db.pool,
      source,
      { ...config, stage: 'metadata', noDrawingNumbers: [] },
      'job',
      vi.fn(),
    )
    const inserted = db.calls.find((call) =>
      call.sql.includes('INSERT INTO cnipa.patent\n'),
    )!
    expect(inserted.values?.[6]).toBeNull()
    expect(inserted.values?.[7]).toBeNull()
    expect(
      db.calls.some((call) => call.sql.startsWith('DELETE FROM cnipa.patent')),
    ).toBe(false)
  })
  it('正文可先建立公开号记录，未知日期不创建公告批次', async () => {
    const db = database()
    await publishRecord(
      db.pool,
      {
        ...record(),
        application: '',
        date: '',
        title: '',
        grant: '',
        grantDate: '',
        claims: '',
      },
      { ...config, stage: 'text' },
      'job',
      vi.fn(),
    )
    const inserted = db.calls.find((call) =>
      call.sql.includes('INSERT INTO cnipa.patent\n'),
    )!
    expect(inserted.values?.slice(2, 5)).toEqual([null, null, null])
    expect(inserted.values?.[6]).toBe(
      JSON.stringify({ embodiment: '授权说明书' }),
    )
    expect(inserted.values?.[8]).toBeNull()
    expect(
      db.calls.some((call) => call.sql.includes('INSERT INTO sync_batches')),
    ).toBe(false)
    expect(db.calls.some((call) => call.sql.includes("kind ~ '^A'"))).toBe(
      false,
    )
    expect(db.query).toHaveBeenCalledWith('COMMIT')
  })
  it('授权成功入库后才删除同申请的 A 记录', async () => {
    const db = database()
    const result = await publishRecord(
      db.pool,
      record(),
      config,
      'job',
      vi.fn(),
    )
    expect(result.removed).toBe(1)
    const insertIndex = db.calls.findIndex((call) =>
      call.sql.includes('INSERT INTO cnipa.patent'),
    )
    const deleteIndex = db.calls.findIndex((call) =>
      call.sql.includes('DELETE FROM cnipa.patent'),
    )
    expect(deleteIndex).toBeGreaterThan(insertIndex)
    expect(db.calls[deleteIndex].values).toEqual([['application']])
    expect(db.query).toHaveBeenCalledWith('COMMIT')
  })
  it('授权发布失败回滚，保留申请数据', async () => {
    const db = database(true)
    await expect(
      publishRecord(db.pool, record(), config, 'job', vi.fn()),
    ).rejects.toThrow()
    expect(db.query).toHaveBeenCalledWith('ROLLBACK')
    expect(db.calls.some((call) => call.sql.includes('DELETE'))).toBe(false)
  })
  it('关闭替换开关时不删除申请记录', async () => {
    const db = database()
    await publishRecord(
      db.pool,
      record(),
      { ...config, cleanupApplications: false },
      'job',
      vi.fn(),
    )
    expect(db.calls.some((call) => call.sql.includes('DELETE'))).toBe(false)
  })
  it('现有授权记录阻止历史 A 版本再次导入', async () => {
    const db = database(false, true)
    const source = { ...record(), publication: 'CN1577321A', kind: 'A' }
    const result = await publishRecord(db.pool, source, config, 'job', vi.fn())
    expect(result.skipped).toBe(true)
    expect(db.calls.some((call) => call.sql.includes('INSERT'))).toBe(false)
    const grant = db.calls.find((call) => call.sql.includes("kind ~ '^[BC]'"))!
    expect(grant.sql).toContain("NULLIF(btrim(p.title),'') IS NOT NULL")
    expect(grant.sql).toContain('p.description IS NOT NULL')
  })
  it('A 暂存记录的基础信息后到时仍清理已经完整授权的申请版本', async () => {
    const db = database(false, true)
    const original = db.query.getMockImplementation()!
    db.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('LEFT JOIN cnipa.history_import_source'))
        return { rows: [{ id: 'application' }], rowCount: 1 }
      return original(sql, values)
    })
    const result = await publishRecord(
      db.pool,
      {
        ...record(),
        publication: 'CN1577321A',
        kind: 'A',
        description: '',
        claims: '',
      },
      { ...config, stage: 'metadata' },
      'late-metadata',
      vi.fn(),
    )
    expect(result.removed).toBe(1)
    expect(
      db.calls.some((call) => call.sql.includes('INSERT INTO cnipa.patent\n')),
    ).toBe(false)
    const update = db.calls.findIndex((call) =>
      call.sql.startsWith('UPDATE cnipa.patent SET title='),
    )
    const deletion = db.calls.findIndex((call) =>
      call.sql.startsWith('DELETE FROM cnipa.patent WHERE'),
    )
    expect(update).toBeGreaterThan(-1)
    expect(deletion).toBeGreaterThan(update)
  })
  it('申请号缺失时即使正文附图齐备也不清理 A', async () => {
    const db = database()
    await publishRecord(
      db.pool,
      { ...record(), application: '' },
      { ...config, stage: 'metadata' },
      'job',
      vi.fn(),
    )
    expect(db.calls.some((call) => call.sql.includes("kind ~ '^A'"))).toBe(
      false,
    )
  })
  it('缺项不得发布，不创建数据库事务', async () => {
    const db = database()
    await expect(
      publishRecord(
        db.pool,
        { ...record(), status: 'blocked' },
        config,
        'job',
        vi.fn(),
      ),
    ).rejects.toThrow()
    expect(db.calls).toHaveLength(0)
  })
  it('公告批次遵循三类前缀并保留文献实际种类码', () => {
    expect(announcementBatch('2008-01-01', 'B')).toBe(
      'CN-PA-TXTS-10-B-20080101',
    )
    expect(announcementBatch('2008-01-01', 'C')).toBe(
      'CN-PA-TXTS-10-B-20080101',
    )
    expect(announcementBatch('2008-01-01', 'A1')).toBe(
      'CN-PA-TXTS-10-A-20080101',
    )
    expect(announcementBatch('2008-01-01', 'U')).toBe(
      'CN-PA-TXTS-20-U-20080101',
    )
    expect(announcementBatch('2008-01-01', 'Y')).toBe(
      'CN-PA-TXTS-20-U-20080101',
    )
    expect(() => announcementBatch('2020-02-30', 'B')).toThrow()
    expect(() => announcementBatch('2008-01-01', 'S')).toThrow()
  })
  it.each(['U', 'Y'])(
    '实用新型 %s 使用 U 批次且不执行发明申请替换',
    async (kind) => {
      const db = database()
      const source = { ...record(), publication: `CN1577321${kind}`, kind }
      await publishRecord(
        db.pool,
        source,
        { ...config, stage: 'metadata' },
        'job',
        vi.fn(),
      )
      const batch = db.calls.find((call) =>
        call.sql.includes('INSERT INTO sync_batches'),
      )!
      expect(batch.values).toEqual([
        'CN-PA-TXTS-20-U-20080101',
        'utility_model',
      ])
      const patent = db.calls.find((call) =>
        call.sql.includes('INSERT INTO cnipa.patent\n'),
      )!
      expect(patent.values?.[0]).toBe('1577321')
      expect(patent.values?.[1]).toBe(kind)
      expect(db.calls.some((call) => call.sql.includes("kind ~ '^A'"))).toBe(
        false,
      )
      expect(source.publication).toBe(`CN1577321${kind}`)
    },
  )
  it('历史导入不能覆盖同名 FTP 批次的运行状态', async () => {
    const db = database()
    await publishRecord(
      db.pool,
      record(),
      { ...config, stage: 'metadata' },
      'job',
      vi.fn(),
    )
    const update = db.calls.find((call) =>
      call.sql.startsWith('UPDATE sync_batches'),
    )!
    expect(update.sql).toContain('AND ftp_folder IS NULL')
  })
})
