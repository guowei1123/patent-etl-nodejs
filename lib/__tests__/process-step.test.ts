import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedPatent } from '@/types'

const dbMock = vi.hoisted(() => ({
  addLog: vi.fn(),
  getBatchByCode: vi.fn(),
  updateBatchProgress: vi.fn(),
  updateBatchStatus: vi.fn(),
}))

const fileMock = vi.hoisted(() => ({
  tempRoot: '',
  calls: [] as string[],
  extractFiles: vi.fn(),
  forEachZipEntry: vi.fn(),
  withPreparedArchiveFiles: vi.fn(),
}))

const integrityMock = vi.hoisted(() => ({
  verifyExtractedFilesCrc: vi.fn(),
  openZipForVerify: vi.fn(),
  formatIntegrityReport: vi.fn(),
}))

const parserMock = vi.hoisted(() => ({
  parsePatentXml: vi.fn(),
}))

vi.mock('../db', () => dbMock)
vi.mock('../integrity', () => integrityMock)
vi.mock('../xml-parser', () => parserMock)
vi.mock('../file-processor', () => ({
  extractFiles: fileMock.extractFiles,
  forEachZipEntry: fileMock.forEachZipEntry,
  getTempPath: (subdir?: string) =>
    subdir ? path.join(fileMock.tempRoot, subdir) : fileMock.tempRoot,
  isPatentXmlFile: vi.fn(() => true),
  withPreparedArchiveFiles: fileMock.withPreparedArchiveFiles,
}))

function parsedPatent(): ParsedPatent {
  return {
    patent_number: '100001',
    patent_type: 'invention',
    title: 'Patent 100001',
  }
}

describe('runProcessStep extracted file verification', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(dbMock)) mock.mockReset()
    for (const mock of Object.values(integrityMock)) mock.mockReset()
    fileMock.extractFiles.mockReset()
    fileMock.forEachZipEntry.mockReset()
    fileMock.withPreparedArchiveFiles.mockReset()
    parserMock.parsePatentXml.mockReset()
    fileMock.calls = []
    fileMock.tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'process-step-'))

    dbMock.getBatchByCode.mockResolvedValue({
      batch_code: 'batch-1',
      data_type: 'invention',
      status: 'downloaded',
    })
    integrityMock.openZipForVerify.mockResolvedValue(undefined)
    integrityMock.formatIntegrityReport.mockReturnValue('完整性检测失败')
    parserMock.parsePatentXml.mockReturnValue(parsedPatent())
    fileMock.withPreparedArchiveFiles.mockImplementation(
      async (_tempPath, callback) => {
        await callback([path.join(fileMock.tempRoot, 'outer.zip')])
      },
    )
    fileMock.extractFiles.mockImplementation(async (_files, outputDir) => {
      fileMock.calls.push('extract')
      fs.mkdirSync(outputDir, { recursive: true })
      fs.writeFileSync(path.join(outputDir, 'INNER.ZIP'), 'zip')
      fs.writeFileSync(path.join(outputDir, 'INNER-CRC.TXT'), 'INNER.ZIP,ABC')
      return [path.join(outputDir, 'INNER.ZIP')]
    })
    fileMock.forEachZipEntry.mockImplementation(async (_zipFile, handler) => {
      fileMock.calls.push('parse')
      handler('100001.xml', '<xml />')
      return { processed: 1, skipped: 0 }
    })
  })

  it('automatically verifies extracted files after extraction and before parsing', async () => {
    integrityMock.verifyExtractedFilesCrc.mockImplementation(async () => {
      fileMock.calls.push('verify')
      return { passed: true, checkedFiles: 1, failures: [] }
    })

    const { runProcessStep } = await import('../etl/process-step')
    const result = await runProcessStep('batch-1')

    expect(result.success).toBe(true)
    expect(fileMock.calls).toEqual(['extract', 'verify', 'parse'])
    expect(dbMock.addLog).toHaveBeenCalledWith(
      'batch-1',
      'info',
      '[自动校验] 解压文件 CRC 通过: 1 个文件',
      undefined,
    )
    expect(dbMock.updateBatchStatus).toHaveBeenLastCalledWith(
      'batch-1',
      'processed',
    )
  })

  it('stops processing when automatic extracted file verification fails', async () => {
    integrityMock.verifyExtractedFilesCrc.mockImplementation(async () => {
      fileMock.calls.push('verify')
      return {
        passed: false,
        checkedFiles: 1,
        failures: [{ file: 'INNER.ZIP', reason: 'CRC32 不匹配' }],
      }
    })

    const { runProcessStep } = await import('../etl/process-step')
    const result = await runProcessStep('batch-1')

    expect(result.success).toBe(false)
    expect(result.error).toContain('CRC 完整性检测失败')
    expect(fileMock.calls).toEqual(['extract', 'verify'])
    expect(fileMock.forEachZipEntry).not.toHaveBeenCalled()
    expect(dbMock.addLog).toHaveBeenCalledWith(
      'batch-1',
      'error',
      '[自动校验] 解压文件 CRC 失败: 1 个问题',
      { failures: [{ file: 'INNER.ZIP', reason: 'CRC32 不匹配' }] },
    )
    expect(dbMock.updateBatchStatus).toHaveBeenLastCalledWith(
      'batch-1',
      'failed',
      expect.stringContaining('CRC 完整性检测失败'),
    )
  })
})
