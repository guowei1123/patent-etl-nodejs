import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedPatent, PatentImportResult } from '@/types'

const dbMock = vi.hoisted(() => ({
  addLog: vi.fn(),
  countImportedPatentsByBatch: vi.fn(),
  getBatchByCode: vi.fn(),
  getImportedPatentKeysByBatch: vi.fn(),
  insertPatents: vi.fn(),
  updateBatchProgress: vi.fn(),
  updateBatchStatus: vi.fn(),
}))

const fileMock = vi.hoisted(() => ({
  tempRoot: '',
}))

vi.mock('../db', () => dbMock)
vi.mock('../file-processor', () => ({
  getTempPath: (subdir?: string) => {
    const target = subdir ? path.join(fileMock.tempRoot, subdir) : fileMock.tempRoot
    fs.mkdirSync(target, { recursive: true })
    return target
  },
}))

function patent(patentNumber: string): ParsedPatent {
  return {
    patent_number: patentNumber,
    patent_type: 'invention',
    title: `Patent ${patentNumber}`,
    source_file: `${patentNumber}.xml`,
  }
}

describe('runImportStep failure details', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(dbMock)) mock.mockReset()
    fileMock.tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'import-step-'))
  })

  it('marks the batch failed and writes structured failed patent details', async () => {
    const patents = [patent('ok-1'), patent('bad'), patent('ok-2')]
    const parsedDir = path.join(fileMock.tempRoot, 'batch-1')
    fs.mkdirSync(parsedDir, { recursive: true })
    fs.writeFileSync(path.join(parsedDir, 'parsed.json'), JSON.stringify(patents))

    dbMock.getBatchByCode.mockResolvedValue({
      batch_code: 'batch-1',
      status: 'processed',
    })
    dbMock.countImportedPatentsByBatch
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2)
    dbMock.getImportedPatentKeysByBatch.mockResolvedValue(new Set())
    dbMock.insertPatents.mockResolvedValue({
      insertedCount: 2,
      failures: [
        {
          patent_number: 'bad',
          kind: 'B',
          title: 'Patent bad',
          source_file: 'bad.xml',
          error: 'invalid input syntax for type date',
        },
      ],
    } satisfies PatentImportResult)

    const { runImportStep } = await import('../etl/import-step')
    const result = await runImportStep('batch-1')

    expect(result.success).toBe(false)
    expect(result.error).toBe('导入未完成: 已导入 2 / 3 条记录，失败 1 条')
    expect(dbMock.updateBatchStatus).toHaveBeenLastCalledWith(
      'batch-1',
      'failed',
      '导入未完成: 已导入 2 / 3 条记录，失败 1 条',
    )
    expect(dbMock.addLog).toHaveBeenLastCalledWith(
      'batch-1',
      'error',
      '导入未完成: 已导入 2 / 3 条记录，失败 1 条',
      {
        failures: [
          {
            patent_number: 'bad',
            kind: 'B',
            title: 'Patent bad',
            source_file: 'bad.xml',
            error: 'invalid input syntax for type date',
          },
        ],
        importedPatents: 2,
        totalPatents: 3,
      },
    )
  })
})
