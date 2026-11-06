import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FtpEntry } from '@/types'
import { writeDownloadManifest } from '../integrity'

const dbMock = vi.hoisted(() => ({
  getBatchByCode: vi.fn(),
  updateBatchStatus: vi.fn(),
  updateBatchProgress: vi.fn(),
  addLog: vi.fn(),
}))
const ftpMock = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  listDirectory: vi.fn(),
  createPool: vi.fn(),
  poolConnect: vi.fn(),
  poolDisconnect: vi.fn(),
  downloadFiles: vi.fn(),
}))
const local = vi.hoisted(() => ({ directory: '' }))
vi.mock('../db', () => dbMock)
vi.mock('../file-processor', () => ({ getTempPath: () => local.directory }))
vi.mock('../ftp-client', () => ({
  createFtpClient: () => ({
    connect: ftpMock.connect,
    disconnect: ftpMock.disconnect,
    listDirectory: ftpMock.listDirectory,
  }),
  createFtpPool: ftpMock.createPool,
}))

function entry(name: string, type: 'file' | 'directory' = 'file'): FtpEntry {
  return {
    name,
    type,
    size: name.endsWith('.zip') ? 22 : 128,
    path: `/source/20240906/${name}`,
    modifiedAt: null,
  }
}

describe('runDownloadStep source-list validation', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(dbMock)) mock.mockReset()
    for (const mock of Object.values(ftpMock)) mock.mockReset()
    local.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'download-step-'))
    dbMock.getBatchByCode.mockResolvedValue({
      batch_code: 'batch-1',
      status: 'pending',
      ftp_folder: '/source/20240906',
    })
    ftpMock.createPool.mockReturnValue({
      connect: ftpMock.poolConnect,
      disconnect: ftpMock.poolDisconnect,
      downloadFiles: ftpMock.downloadFiles,
      getConcurrency: () => 2,
      getTimeout: () => 120000,
    })
  })
  afterEach(() => {
    fs.rmSync(local.directory, { recursive: true, force: true })
  })

  it.each([
    { entries: [], message: 'FTP 目录返回空列表' },
    { entries: [entry('nested', 'directory')], message: '只返回子目录' },
    { entries: [entry('readme.txt')], message: '没有 ZIP' },
    { entries: [entry('20240906.z01')], message: '缺少主 ZIP' },
  ])(
    'stops before downloading or overwriting the manifest: $message',
    async ({ entries, message }) => {
      const files = [entry('20240906.z01'), entry('20240906.zip')]
      writeDownloadManifest(local.directory, files)
      const manifestPath = path.join(
        local.directory,
        '.archive-download-manifest.json',
      )
      const previous = fs.readFileSync(manifestPath, 'utf8')
      fs.writeFileSync(
        path.join(local.directory, '20240906.z01'),
        Buffer.alloc(128),
      )
      ftpMock.listDirectory.mockResolvedValue(entries)
      const { runDownloadStep } = await import('../etl/download-step')
      const result = await runDownloadStep('batch-1')
      expect(result.success).toBe(false)
      expect(result.error).toContain(message)
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(previous)
      expect(fs.statSync(path.join(local.directory, '20240906.z01')).size).toBe(
        128,
      )
      expect(ftpMock.createPool).not.toHaveBeenCalled()
      expect(ftpMock.downloadFiles).not.toHaveBeenCalled()
      expect(dbMock.updateBatchProgress).not.toHaveBeenCalled()
      expect(dbMock.updateBatchStatus).toHaveBeenLastCalledWith(
        'batch-1',
        'failed',
        expect.stringContaining(message),
      )
      expect(ftpMock.disconnect).toHaveBeenCalled()
    },
  )

  it('downloads a complete remote set with resume enabled and still verifies integrity', async () => {
    const files = [entry('20240906.z01'), entry('20240906.zip')]
    ftpMock.listDirectory.mockResolvedValue(files)
    ftpMock.downloadFiles.mockImplementation(
      async (entries, directory, options) => {
        expect(options.resume).toBe(true)
        for (const file of entries) {
          const content = Buffer.alloc(file.size)
          if (file.name.endsWith('.zip')) content.writeUInt32LE(0x06054b50)
          fs.writeFileSync(path.join(directory, file.name), content)
        }
        return {
          totalProcessed: 2,
          skippedCount: 0,
          downloadedPaths: entries.map((file: FtpEntry) =>
            path.join(directory, file.name),
          ),
        }
      },
    )
    const { runDownloadStep } = await import('../etl/download-step')
    expect(await runDownloadStep('batch-1')).toMatchObject({
      success: true,
      details: { totalFiles: 2 },
    })
    expect(dbMock.updateBatchStatus).toHaveBeenLastCalledWith(
      'batch-1',
      'downloaded',
    )
    expect(dbMock.addLog).toHaveBeenCalledWith(
      'batch-1',
      'info',
      '下载完整性检测通过: 2 个文件',
      undefined,
    )
    expect(ftpMock.poolDisconnect).toHaveBeenCalled()
  })

  it('does not mark a transfer as downloaded if the main ZIP was not actually written', async () => {
    ftpMock.listDirectory.mockResolvedValue([
      entry('20240906.z01'),
      entry('20240906.zip'),
    ])
    ftpMock.downloadFiles.mockImplementation(async () => {
      fs.writeFileSync(
        path.join(local.directory, '20240906.z01'),
        Buffer.alloc(128),
      )
      return { totalProcessed: 2, skippedCount: 0, downloadedPaths: [] }
    })
    const { runDownloadStep } = await import('../etl/download-step')
    const result = await runDownloadStep('batch-1')
    expect(result.success).toBe(false)
    expect(result.error).toContain('主 ZIP 文件不存在')
    expect(dbMock.updateBatchStatus).not.toHaveBeenCalledWith(
      'batch-1',
      'downloaded',
    )
  })
})
