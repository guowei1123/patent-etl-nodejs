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
  forEachZipEntryBuffer: vi.fn(),
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

const ossMock = vi.hoisted(() => ({
  buildPatentImageKey: vi.fn(),
  isOssConfigured: vi.fn(),
  patentImageExists: vi.fn(),
  putPatentImage: vi.fn(),
}))

vi.mock('../db', () => dbMock)
vi.mock('../integrity', () => integrityMock)
vi.mock('../xml-parser', () => parserMock)
vi.mock('../oss-client', () => ossMock)
vi.mock('../filter-config', () => ({
  filterPatents: vi.fn((patents) => ({
    filtered: patents,
    skipped: 0,
    ipcMatched: patents.length,
    entityMatched: 0,
    bothMatched: 0,
  })),
}))
vi.mock('../file-processor', () => ({
  extractFiles: fileMock.extractFiles,
  forEachZipEntryBuffer: fileMock.forEachZipEntryBuffer,
  getTempPath: (subdir?: string) =>
    subdir ? path.join(fileMock.tempRoot, subdir) : fileMock.tempRoot,
  isPatentImageFile: vi.fn((fileName: string) => /\.jpe?g$/i.test(fileName)),
  isPatentXmlFile: vi.fn((fileName: string) => /\.xml$/i.test(fileName)),
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
    fileMock.forEachZipEntryBuffer.mockReset()
    fileMock.withPreparedArchiveFiles.mockReset()
    parserMock.parsePatentXml.mockReset()
    ossMock.buildPatentImageKey.mockReset()
    ossMock.isOssConfigured.mockReset()
    ossMock.patentImageExists.mockReset()
    ossMock.putPatentImage.mockReset()
    delete process.env.PROCESS_UPLOAD_IMAGES
    fileMock.calls = []
    fileMock.tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'process-step-'))

    dbMock.getBatchByCode.mockResolvedValue({
      batch_code: 'batch-1',
      data_type: 'invention',
      status: 'downloaded',
    })
    integrityMock.openZipForVerify.mockResolvedValue(undefined)
    integrityMock.formatIntegrityReport.mockReturnValue('完整性检测失败')
    parserMock.parsePatentXml.mockReturnValue({
      ...parsedPatent(),
      abstract_figure: '100001.jpg',
      image_files: ['100001.jpg'],
    })
    ossMock.isOssConfigured.mockReturnValue(true)
    ossMock.patentImageExists.mockResolvedValue(false)
    ossMock.buildPatentImageKey.mockImplementation(
      (batchCode: string, docNumber: string, fileName: string) =>
        `patents/${batchCode}/${docNumber}/${fileName}`,
    )
    ossMock.putPatentImage.mockResolvedValue(undefined)
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
    fileMock.forEachZipEntryBuffer.mockImplementation(
      async (_zipFile, handler, filter) => {
        fileMock.calls.push('parse')
        const entries: [string, Buffer][] = [
          ['100001.xml', Buffer.from('<xml />')],
          ['100001.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
          ['unreferenced.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
        ]
        let processed = 0
        let skipped = 0
        for (const [fileName, content] of entries) {
          if (filter && !filter(fileName)) {
            skipped++
            continue
          }
          await handler(fileName, content)
          processed++
        }
        return { processed, skipped }
      },
    )
  })

  it('automatically verifies extracted files after extraction and before parsing', async () => {
    integrityMock.verifyExtractedFilesCrc.mockImplementation(async () => {
      fileMock.calls.push('verify')
      return { passed: true, checkedFiles: 1, failures: [] }
    })

    const { runProcessStep } = await import('../etl/process-step')
    const result = await runProcessStep('batch-1')

    expect(result.success).toBe(true)
    expect(fileMock.calls).toEqual(['extract', 'verify', 'parse', 'parse'])
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
    expect(ossMock.putPatentImage).toHaveBeenCalledWith(
      'patents/batch-1/100001/100001.jpg',
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      'image/jpeg',
    )
    const parsedPath = path.join(fileMock.tempRoot, 'batch-1', 'parsed.json')
    const parsed = JSON.parse(fs.readFileSync(parsedPath, 'utf-8'))
    expect(parsed[0].images[0].oss_key).toBe(
      'patents/batch-1/100001/100001.jpg',
    )
  })

  it('skips uploading existing patent images and still writes metadata', async () => {
    integrityMock.verifyExtractedFilesCrc.mockResolvedValue({
      passed: true,
      checkedFiles: 1,
      failures: [],
    })
    ossMock.patentImageExists.mockResolvedValue(true)

    const { runProcessStep } = await import('../etl/process-step')
    const result = await runProcessStep('batch-1')

    expect(result.success).toBe(true)
    expect(ossMock.putPatentImage).not.toHaveBeenCalled()
    const parsedPath = path.join(fileMock.tempRoot, 'batch-1', 'parsed.json')
    const parsed = JSON.parse(fs.readFileSync(parsedPath, 'utf-8'))
    expect(parsed[0].images[0].oss_key).toBe(
      'patents/batch-1/100001/100001.jpg',
    )
  })

  it('fails the process step when patent image upload fails', async () => {
    integrityMock.verifyExtractedFilesCrc.mockResolvedValue({
      passed: true,
      checkedFiles: 1,
      failures: [],
    })
    ossMock.putPatentImage.mockRejectedValue(new Error('upload timeout'))

    const { runProcessStep } = await import('../etl/process-step')
    const result = await runProcessStep('batch-1')

    expect(result.success).toBe(false)
    expect(result.error).toContain('专利附图上传失败')
    expect(result.error).toContain('upload timeout')
    expect(dbMock.updateBatchStatus).toHaveBeenLastCalledWith(
      'batch-1',
      'failed',
      expect.stringContaining('专利附图上传失败'),
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
    expect(fileMock.forEachZipEntryBuffer).not.toHaveBeenCalled()
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
