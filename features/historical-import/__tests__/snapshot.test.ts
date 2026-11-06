import { describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import type pg from 'pg'
import { snapshotRequested } from '../database-snapshot'
import { configSchema } from '../model'
import { applicationKey } from '../identity'

describe('分批关联数据库', () => {
  it('每 250 项关联数据库，未命中的公开号生成待补齐候选', async () => {
    const directory = path.resolve('data/historical-import/validation/snapshot')
    await mkdir(directory, { recursive: true })
    const numbers = Array.from(
      { length: 251 },
      (_, index) => `CN${1000000 + index}B`,
    )
    await writeFile(
      path.join(directory, 'requested.jsonl'),
      numbers.map((number) => JSON.stringify(number)).join('\n'),
    )
    const query = vi.fn(async (_sql: string, values: unknown[]) => ({
      rows: (values[0] as string[])
        .filter((number) => numbers.includes(number) && number !== numbers[250])
        .map((publication) => ({
          id: publication,
          publication,
          application: 'CN2004100587248',
          kind: 'B',
          date: '2008-01-01',
          title: '基础信息',
          abstract: '',
          grant: '',
          grantDate: '',
        })),
      rowCount: 250,
    }))
    await snapshotRequested(
      { query } as unknown as pg.Pool,
      directory,
      configSchema.parse({
        stage: 'text',
        descriptionPath: 'test.parquet',
        columns: {},
      }),
    )
    expect(query).toHaveBeenCalledTimes(2)
    expect((query.mock.calls[0][1][0] as string[]).length).toBe(750)
    expect((query.mock.calls[1][1][0] as string[]).length).toBe(3)
    expect(
      (await readFile(path.join(directory, 'database-records.jsonl'), 'utf8'))
        .trim()
        .split('\n'),
    ).toHaveLength(251)
    const rows = (
      await readFile(path.join(directory, 'database-records.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(rows[250]).toMatchObject({
      publication: numbers[250],
      application: '',
      date: '',
      title: '',
      metadataPending: true,
      status: 'ready',
    })
    expect(
      await readFile(path.join(directory, 'database-errors.jsonl'), 'utf8'),
    ).toBe('')
    expect(query.mock.calls[0][0]).toContain('p.doc_number=ANY')
    expect(query.mock.calls[0][0]).not.toContain('pub_date::date')
  })
  it('重复公开号不当成新文献创建，保留异常报告', async () => {
    const directory = path.resolve(
      'data/historical-import/validation/snapshot-conflict',
    )
    await mkdir(directory, { recursive: true })
    await writeFile(
      path.join(directory, 'requested.jsonl'),
      JSON.stringify('CN1577321B'),
    )
    const query = vi.fn(async () => ({
      rows: [{ publication: 'CN1577321B' }, { publication: 'CN1577321B' }],
      rowCount: 2,
    }))
    await snapshotRequested(
      { query } as unknown as pg.Pool,
      directory,
      configSchema.parse({
        stage: 'text',
        descriptionPath: 'input.parquet',
        columns: {},
      }),
    )
    expect(
      await readFile(path.join(directory, 'database-records.jsonl'), 'utf8'),
    ).toBe('')
    expect(
      await readFile(path.join(directory, 'database-errors.jsonl'), 'utf8'),
    ).toContain('重复公开号')
  })
  it('各阶段只校验自己的必需来源', () => {
    expect(
      configSchema.safeParse({
        stage: 'metadata',
        excelPath: 'info.xlsx',
        columns: {},
      }).success,
    ).toBe(true)
    expect(
      configSchema.safeParse({
        stage: 'text',
        claimsPath: 'claims.parquet',
        columns: {},
      }).success,
    ).toBe(true)
    expect(
      configSchema.safeParse({
        stage: 'images',
        pdfPath: 'docs.zip',
        columns: {},
      }).success,
    ).toBe(true)
    expect(configSchema.safeParse({ stage: 'text', columns: {} }).success).toBe(
      false,
    )
  })
  it('FTP 不含校验位的申请号与 Excel 完整申请号匹配同一申请', () => {
    expect(applicationKey('201710910977')).toBe(
      applicationKey('CN201710910977.8'),
    )
    expect(applicationKey('99101385')).toBe(applicationKey('ZL99101385.X'))
    expect(() => applicationKey('invalid')).toThrow()
  })
})
