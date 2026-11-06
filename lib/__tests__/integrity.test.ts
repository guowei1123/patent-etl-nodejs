import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as zlib from 'zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  verifyDownloadedArchive,
  verifyExtractedFilesCrc,
  writeDownloadManifest,
  formatIntegrityReport,
} from '../integrity'

const yauzlMock = vi.hoisted(() => ({
  open: vi.fn(),
}))

vi.mock('yauzl', () => ({
  default: yauzlMock,
}))

let tmpDir: string

function crc32(content: string | Buffer): string {
  return zlib.crc32(Buffer.from(content)).toString(16).toUpperCase()
}

function writeFile(
  name: string,
  content: string | Buffer = 'zip-data',
): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, content)
  return filePath
}

describe('verifyExtractedFilesCrc', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-'))
    yauzlMock.open.mockReset()
    yauzlMock.open.mockImplementation((_zipPath, _options, callback) => {
      callback(null, { close: vi.fn() })
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes when CRC entries match the extracted ZIP set', async () => {
    writeFile('INNER.ZIP', 'zip-content')
    writeFile('INNER-CRC.TXT', `INNER.ZIP,${crc32('zip-content')}`)

    const result = await verifyExtractedFilesCrc(tmpDir)

    expect(result).toEqual({ passed: true, checkedFiles: 1, failures: [] })
    expect(yauzlMock.open).toHaveBeenCalledWith(
      path.join(tmpDir, 'INNER.ZIP'),
      { lazyEntries: true },
      expect.any(Function),
    )
  })

  it('pads computed CRC values before comparing with the CRC manifest', async () => {
    const content = Buffer.from('22', 'hex')
    expect(crc32(content)).toBe('762AE69')

    writeFile('INNER.ZIP', content)
    writeFile('INNER-CRC.TXT', 'INNER.ZIP,0762AE69')

    const result = await verifyExtractedFilesCrc(tmpDir)

    expect(result).toEqual({ passed: true, checkedFiles: 1, failures: [] })
  })

  it('fails when a CRC entry points to a missing ZIP', async () => {
    writeFile('INNER-CRC.TXT', 'MISSING.ZIP,ABCDEF')

    const result = await verifyExtractedFilesCrc(tmpDir)

    expect(result.passed).toBe(false)
    expect(result.checkedFiles).toBe(1)
    expect(result.failures).toContainEqual({
      file: 'MISSING.ZIP',
      expected: '00ABCDEF',
      reason: '文件不存在',
    })
  })

  it('fails when an extracted ZIP is not covered by the CRC manifest', async () => {
    writeFile('INNER.ZIP', 'zip-content')
    writeFile('EXTRA.ZIP', 'extra-content')
    writeFile('INNER-CRC.TXT', `INNER.ZIP,${crc32('zip-content')}`)

    const result = await verifyExtractedFilesCrc(tmpDir)

    expect(result.passed).toBe(false)
    expect(result.checkedFiles).toBe(1)
    expect(result.failures).toContainEqual({
      file: 'EXTRA.ZIP',
      reason: 'ZIP 文件未出现在 CRC 清单中',
    })
  })

  it('fails when a CRC file has no valid entries', async () => {
    writeFile('EMPTY-CRC.TXT', 'not a crc entry')

    const result = await verifyExtractedFilesCrc(tmpDir)

    expect(result.passed).toBe(false)
    expect(result.checkedFiles).toBe(0)
    expect(result.failures).toContainEqual({
      file: 'EMPTY-CRC.TXT',
      reason: 'CRC 文件无有效校验条目',
    })
  })

  it('matches CRC entries to ZIP files case-insensitively', async () => {
    writeFile('inner.zip', 'zip-content')
    writeFile('INNER-CRC.TXT', `INNER.ZIP,${crc32('zip-content')}`)

    const result = await verifyExtractedFilesCrc(tmpDir)

    expect(result).toEqual({ passed: true, checkedFiles: 1, failures: [] })
    expect(yauzlMock.open).toHaveBeenCalledWith(
      path.join(tmpDir, 'inner.zip'),
      { lazyEntries: true },
      expect.any(Function),
    )
  })

  it('keeps the no-CRC fallback failure for an empty extracted directory', async () => {
    const result = await verifyExtractedFilesCrc(tmpDir)

    expect(result).toEqual({
      passed: false,
      checkedFiles: 0,
      failures: [{ file: tmpDir, reason: '解压目录为空，文件可能未解压' }],
    })
  })

  it('keeps the no-CRC fallback failure when no ZIP files exist', async () => {
    writeFile('README.TXT', 'not a zip')

    const result = await verifyExtractedFilesCrc(tmpDir)

    expect(result).toEqual({
      passed: false,
      checkedFiles: 0,
      failures: [
        { file: tmpDir, reason: '解压目录中无 ZIP 文件，解压可能不完整' },
      ],
    })
  })

  it('keeps the no-CRC fallback ZIP open check', async () => {
    writeFile('INNER.ZIP', 'zip-content')

    const result = await verifyExtractedFilesCrc(tmpDir)

    expect(result).toEqual({ passed: true, checkedFiles: 1, failures: [] })
    expect(yauzlMock.open).toHaveBeenCalledWith(
      path.join(tmpDir, 'INNER.ZIP'),
      { lazyEntries: true },
      expect.any(Function),
    )
  })
})

describe('verifyDownloadedArchive', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-download-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('does not accept an empty local directory as a completed download', async () => {
    const result = await verifyDownloadedArchive(tmpDir)
    expect(result.passed).toBe(false)
    expect(result.failures[0].reason).toContain('请先执行下载')
  })

  it('rejects a legacy empty manifest and counts the existing orphaned volumes', async () => {
    writeFile(
      '.archive-download-manifest.json',
      JSON.stringify({ version: 1, files: [] }),
    )
    writeFile('20240906.z01', Buffer.alloc(32))
    writeFile('20240906.z02', Buffer.alloc(32))
    const result = await verifyDownloadedArchive(tmpDir)
    expect(result.passed).toBe(false)
    expect(result.checkedFiles).toBe(2)
    expect(result.failures).toContainEqual({
      file: '20240906.zip',
      reason: '主 ZIP 文件不存在',
    })
    expect(
      result.failures.some((failure) => failure.reason.includes('清单为空')),
    ).toBe(true)
    expect(formatIntegrityReport(result)).toContain('已检查 2 个文件')
    expect(formatIntegrityReport(result)).not.toContain('/0')
  })

  it('preserves the last trusted manifest when an empty or incomplete source list arrives', () => {
    const files = [
      { name: 'batch.z01', size: 1024 },
      { name: 'batch.zip', size: 22 },
    ]
    writeDownloadManifest(tmpDir, files)
    const manifestPath = path.join(tmpDir, '.archive-download-manifest.json')
    const previous = fs.readFileSync(manifestPath, 'utf8')
    expect(() => writeDownloadManifest(tmpDir, [])).toThrow('下载清单为空')
    expect(() => writeDownloadManifest(tmpDir, files.slice(0, 1))).toThrow(
      '缺少主 ZIP',
    )
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(previous)
  })

  it('rejects a split archive whose main ZIP was only partially downloaded', async () => {
    writeFile('batch.z01', Buffer.alloc(1024, 1))
    writeFile('batch.z02', Buffer.alloc(1024, 2))
    writeFile('batch.zip', Buffer.alloc(512, 3))

    const result = await verifyDownloadedArchive(tmpDir)

    expect(result.passed).toBe(false)
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        file: 'batch.zip',
        reason: '主 ZIP 文件缺少结束目录，下载可能未完成',
      }),
    )
  })

  it('rejects a truncated single split part using the persisted FTP sizes', async () => {
    const mainZip = Buffer.alloc(22)
    mainZip.writeUInt32LE(0x06054b50, 0)
    writeFile('batch.z01', Buffer.alloc(900, 1))
    writeFile('batch.zip', mainZip)
    writeDownloadManifest(tmpDir, [
      { name: 'batch.z01', size: 1024 },
      { name: 'batch.zip', size: mainZip.length },
    ])

    const result = await verifyDownloadedArchive(tmpDir)

    expect(result.passed).toBe(false)
    expect(result.failures).toContainEqual({
      file: 'batch.z01',
      expected: '1024 bytes',
      actual: '900 bytes',
      reason: '文件大小与 FTP 源文件不一致，下载可能未完成',
    })
  })

  it('accepts a complete single split part when FTP sizes match', async () => {
    const mainZip = Buffer.alloc(22)
    mainZip.writeUInt32LE(0x06054b50, 0)
    writeFile('batch.z01', Buffer.alloc(1024, 1))
    writeFile('batch.zip', mainZip)
    writeDownloadManifest(tmpDir, [
      { name: 'batch.z01', size: 1024 },
      { name: 'batch.zip', size: mainZip.length },
    ])

    const result = await verifyDownloadedArchive(tmpDir)

    expect(result).toEqual({ passed: true, checkedFiles: 2, failures: [] })
  })

  it('rejects a legacy single split part without a trusted size manifest', async () => {
    const mainZip = Buffer.alloc(22)
    mainZip.writeUInt32LE(0x06054b50, 0)
    writeFile('batch.z01', Buffer.alloc(1024, 1))
    writeFile('batch.zip', mainZip)

    const result = await verifyDownloadedArchive(tmpDir)

    expect(result.passed).toBe(false)
    expect(result.failures).toContainEqual({
      file: 'batch.z01',
      reason:
        '缺少 FTP 源文件大小清单，无法确认单个分卷是否下载完整，请重新执行下载',
    })
  })
})
