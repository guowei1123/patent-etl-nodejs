import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import yauzl from 'yauzl'

// ============ 类型定义 ============

export interface IntegrityCheckResult {
  passed: boolean
  checkedFiles: number
  failures: IntegrityFailure[]
}

export interface IntegrityFailure {
  file: string
  expected?: string
  actual?: string
  reason: string
}

interface CrcEntry {
  relativePath: string
  expectedCrc: string
}

const ZIP_EOCD_SIGNATURE = 0x06054b50
const DOWNLOAD_MANIFEST_FILE = '.archive-download-manifest.json'
const DOWNLOAD_MANIFEST_VERSION = 1

interface DownloadManifestFile {
  name: string
  size: number
}

interface DownloadManifest {
  version: number
  files: DownloadManifestFile[]
}

export function writeDownloadManifest(
  dirPath: string,
  files: DownloadManifestFile[],
): void {
  // 空清单或不完整的远端分卷不能覆盖上次用于续传校验的清单。
  if (files.length === 0) {
    throw new Error(
      'FTP 下载清单为空，已停止下载并保留本地文件，请确认源站目录、路径及账号权限后重试',
    )
  }
  const names = new Set(files.map((file) => file.name.toLowerCase()))
  const missingMainZips = new Set<string>()
  for (const file of files) {
    const match = file.name.match(/^(.*)\.z\d+$/i)
    if (match && !names.has(`${match[1]}.zip`.toLowerCase())) {
      missingMainZips.add(`${match[1]}.zip`)
    }
  }
  if (missingMainZips.size > 0) {
    throw new Error(
      `FTP 源文件清单缺少主 ZIP：${Array.from(missingMainZips).join('、')}。已停止下载并保留本地文件，请确认源站文件齐全后重试`,
    )
  }
  fs.mkdirSync(dirPath, { recursive: true })
  const manifest: DownloadManifest = {
    version: DOWNLOAD_MANIFEST_VERSION,
    files: files.map((file) => ({
      name: path.basename(file.name),
      size: file.size,
    })),
  }
  fs.writeFileSync(
    path.join(dirPath, DOWNLOAD_MANIFEST_FILE),
    JSON.stringify(manifest),
  )
}

function readDownloadManifest(dirPath: string): DownloadManifest | null {
  const manifestPath = path.join(dirPath, DOWNLOAD_MANIFEST_FILE)
  if (!fs.existsSync(manifestPath)) return null

  try {
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8'),
    ) as DownloadManifest
    if (
      manifest.version !== DOWNLOAD_MANIFEST_VERSION ||
      !Array.isArray(manifest.files)
    ) {
      return null
    }

    const files = manifest.files.filter(
      (file) =>
        file &&
        typeof file.name === 'string' &&
        path.basename(file.name) === file.name &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0,
    )
    if (files.length !== manifest.files.length) return null

    return { version: manifest.version, files }
  } catch {
    return null
  }
}

async function hasZipEndOfCentralDirectory(filePath: string): Promise<boolean> {
  const { size } = await fs.promises.stat(filePath)
  if (size < 22) return false

  const searchLength = Math.min(size, 65535 + 22)
  const buffer = Buffer.alloc(searchLength)
  const file = await fs.promises.open(filePath, 'r')
  try {
    await file.read(buffer, 0, searchLength, size - searchLength)
  } finally {
    await file.close()
  }

  for (let index = searchLength - 22; index >= 0; index--) {
    if (buffer.readUInt32LE(index) === ZIP_EOCD_SIGNATURE) return true
  }
  return false
}

function normalizeCrc32(value: string | number): string {
  return value.toString(16).toUpperCase().replace(/^0X/, '').padStart(8, '0')
}

// ============ CRC32 计算 ============

export async function computeFileCrc32(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 })
    let crcValue = 0

    stream.on('data', (chunk: string | Buffer) => {
      crcValue = zlib.crc32(chunk, crcValue)
    })

    stream.on('end', () => {
      resolve(normalizeCrc32(crcValue))
    })

    stream.on('error', reject)
  })
}

// ============ 多卷 ZIP 完整性检测 ============

export async function verifyDownloadedArchive(
  dirPath: string,
): Promise<IntegrityCheckResult> {
  const failures: IntegrityFailure[] = []
  let checkedFiles = 0

  if (!fs.existsSync(dirPath)) {
    return {
      passed: false,
      checkedFiles: 0,
      failures: [{ file: dirPath, reason: '目录不存在' }],
    }
  }

  const manifest = readDownloadManifest(dirPath)
  if (manifest && manifest.files.length === 0) {
    failures.push({
      file: DOWNLOAD_MANIFEST_FILE,
      reason:
        'FTP 下载清单为空，无法确认文件是否齐全，请核对源站目录后重新下载',
    })
  }
  const manifestFileNames = new Set(
    manifest?.files.map((file) => file.name.toLowerCase()) ?? [],
  )
  if (manifest) {
    for (const expectedFile of manifest.files) {
      checkedFiles++
      const filePath = path.join(dirPath, expectedFile.name)
      if (!fs.existsSync(filePath)) {
        failures.push({
          file: expectedFile.name,
          expected: `${expectedFile.size} bytes`,
          actual: '0 bytes',
          reason: '下载文件缺失',
        })
        continue
      }

      const actualSize = fs.statSync(filePath).size
      if (actualSize !== expectedFile.size) {
        failures.push({
          file: expectedFile.name,
          expected: `${expectedFile.size} bytes`,
          actual: `${actualSize} bytes`,
          reason: '文件大小与 FTP 源文件不一致，下载可能未完成',
        })
      }
    }
  }

  const entries = fs.readdirSync(dirPath).filter((f) => {
    const lower = f.toLowerCase()
    return (
      lower.endsWith('.zip') ||
      /^\.(z|zip)\d+$/.test(lower.substring(lower.lastIndexOf('.'))) ||
      /^\.z\d+$/.test(lower.substring(lower.lastIndexOf('.')))
    )
  })
  if (entries.length === 0 && !manifest) {
    failures.push({
      file: dirPath,
      reason: '未发现下载的压缩文件或有效下载清单，请先执行下载',
    })
  }

  // 按基础名分组
  const groups = new Map<string, string[]>()
  for (const entry of entries) {
    const lower = entry.toLowerCase()
    let baseName: string

    if (lower.endsWith('.zip')) {
      baseName = entry.substring(0, entry.length - 4)
    } else {
      const extMatch = lower.match(/^(.*)(\.z\d+)$/)
      baseName = extMatch
        ? entry.substring(0, entry.length - extMatch[2].length)
        : entry
    }

    if (!groups.has(baseName)) groups.set(baseName, [])
    groups.get(baseName)!.push(entry)
  }

  const groupEntries = Array.from(groups.entries())
  for (const [baseName, files] of groupEntries) {
    const hasMainZip = files.some((f) => f.toLowerCase().endsWith('.zip'))
    const splitParts = files
      .filter((f) => {
        const ext = f.substring(f.lastIndexOf('.')).toLowerCase()
        return /^\.z\d+$/.test(ext)
      })
      .sort((a, b) => {
        const numA = parseInt(a.substring(a.lastIndexOf('.') + 2), 10)
        const numB = parseInt(b.substring(b.lastIndexOf('.') + 2), 10)
        return numA - numB
      })

    if (!hasMainZip && splitParts.length === 0) continue

    checkedFiles += files.filter(
      (file) => !manifestFileNames.has(file.toLowerCase()),
    ).length

    if (!hasMainZip) {
      failures.push({ file: `${baseName}.zip`, reason: '主 ZIP 文件不存在' })
      continue
    }

    // 检查分卷文件大小一致性
    if (splitParts.length > 0) {
      if (!manifest && splitParts.length === 1) {
        failures.push({
          file: splitParts[0],
          reason:
            '缺少 FTP 源文件大小清单，无法确认单个分卷是否下载完整，请重新执行下载',
        })
      }

      const mainZipPath = path.join(dirPath, `${baseName}.zip`)
      const mainZipStat = fs.statSync(mainZipPath)
      if (mainZipStat.size === 0) {
        failures.push({
          file: `${baseName}.zip`,
          reason: '主 ZIP 文件大小为 0',
        })
      } else if (!(await hasZipEndOfCentralDirectory(mainZipPath))) {
        failures.push({
          file: `${baseName}.zip`,
          reason: '主 ZIP 文件缺少结束目录，下载可能未完成',
        })
      }

      // 验证序号连续
      for (let i = 0; i < splitParts.length; i++) {
        const expectedNum = i + 1
        const actualNum = parseInt(
          splitParts[i].substring(splitParts[i].lastIndexOf('.') + 2),
          10,
        )
        if (actualNum !== expectedNum) {
          failures.push({
            file: splitParts[i],
            reason: `分卷序号不连续，期望 .z${String(expectedNum).padStart(2, '0')}，实际 .z${String(actualNum).padStart(2, '0')}`,
          })
        }

        const stat = fs.statSync(path.join(dirPath, splitParts[i]))
        if (stat.size === 0) {
          failures.push({ file: splitParts[i], reason: '文件大小为 0' })
        }
      }

      // 分卷大小应一致
      if (splitParts.length > 1) {
        const firstSize = fs.statSync(path.join(dirPath, splitParts[0])).size
        for (let i = 1; i < splitParts.length; i++) {
          const size = fs.statSync(path.join(dirPath, splitParts[i])).size
          if (size !== firstSize) {
            failures.push({
              file: splitParts[i],
              reason: `分卷大小不一致: ${splitParts[0]}=${firstSize} bytes, ${splitParts[i]}=${size} bytes`,
            })
          }
        }
      }
    } else {
      // 单 ZIP 文件：尝试用 yauzl 打开验证结构
      const zipPath = path.join(dirPath, `${baseName}.zip`)
      try {
        await openZipForVerify(zipPath)
      } catch (err) {
        failures.push({
          file: zipPath,
          reason: `ZIP 结构损坏: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
  }

  return { passed: failures.length === 0, checkedFiles, failures }
}

// ============ CRC 文件解析 ============

export function parseCrcFile(crcFilePath: string): CrcEntry[] {
  const content = fs.readFileSync(crcFilePath, 'utf-8').trim()
  const results: CrcEntry[] = []

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const commaIdx = trimmed.lastIndexOf(',')
    if (commaIdx === -1) continue

    const pathPart = trimmed.substring(0, commaIdx)
    const crcPart = trimmed.substring(commaIdx + 1).trim()

    // 取反斜杠最后一段作为文件名
    const fileName = pathPart.includes('\\')
      ? pathPart.split('\\').pop()!
      : path.basename(pathPart)

    if (fileName && crcPart) {
      results.push({
        relativePath: fileName,
        expectedCrc: normalizeCrc32(crcPart),
      })
    }
  }

  return results
}

// ============ 解压数据 CRC 检测 ============

export type CrcProgressCallback = (info: {
  currentFile: string
  checkedCount: number
  totalFiles: number
}) => void

export async function verifyExtractedFilesCrc(
  extractDir: string,
  onProgress?: CrcProgressCallback,
): Promise<IntegrityCheckResult> {
  const failures: IntegrityFailure[] = []
  let checkedFiles = 0

  if (!fs.existsSync(extractDir)) {
    return {
      passed: false,
      checkedFiles: 0,
      failures: [{ file: extractDir, reason: 'extracted 目录不存在' }],
    }
  }

  const crcFiles = fs
    .readdirSync(extractDir)
    .filter((f) => f.toUpperCase().endsWith('-CRC.TXT'))

  if (crcFiles.length === 0) {
    const allFiles = fs
      .readdirSync(extractDir)
      .filter((f) => fs.statSync(path.join(extractDir, f)).isFile())

    if (allFiles.length === 0) {
      return {
        passed: false,
        checkedFiles: 0,
        failures: [
          { file: extractDir, reason: '解压目录为空，文件可能未解压' },
        ],
      }
    }

    const zipFiles = allFiles.filter((f) => f.toUpperCase().endsWith('.ZIP'))
    if (zipFiles.length === 0) {
      return {
        passed: false,
        checkedFiles: 0,
        failures: [
          { file: extractDir, reason: '解压目录中无 ZIP 文件，解压可能不完整' },
        ],
      }
    }

    for (const zf of zipFiles) {
      checkedFiles++
      onProgress?.({
        currentFile: zf,
        checkedCount: checkedFiles,
        totalFiles: zipFiles.length,
      })
      try {
        await openZipForVerify(path.join(extractDir, zf))
      } catch (err) {
        failures.push({
          file: zf,
          reason: `ZIP 结构损坏: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    return { passed: failures.length === 0, checkedFiles, failures }
  }

  const allFiles = fs
    .readdirSync(extractDir)
    .filter((f) => fs.statSync(path.join(extractDir, f)).isFile())
  const actualZipFiles = allFiles.filter((f) =>
    f.toUpperCase().endsWith('.ZIP'),
  )
  const actualZipByLowerName = new Map(
    actualZipFiles.map((f) => [f.toLowerCase(), f]),
  )
  const allEntries: CrcEntry[] = []
  const expectedZipNames = new Set<string>()

  for (const crcFile of crcFiles) {
    const crcPath = path.join(extractDir, crcFile)
    const entries = parseCrcFile(crcPath)

    if (entries.length === 0) {
      failures.push({
        file: crcFile,
        reason: 'CRC 文件无有效校验条目',
      })
    }

    for (const entry of entries) {
      allEntries.push(entry)
      if (entry.relativePath.toUpperCase().endsWith('.ZIP')) {
        expectedZipNames.add(entry.relativePath.toLowerCase())
      }
    }
  }

  for (const zipFile of actualZipFiles) {
    if (!expectedZipNames.has(zipFile.toLowerCase())) {
      failures.push({
        file: zipFile,
        reason: 'ZIP 文件未出现在 CRC 清单中',
      })
    }
  }

  const totalEntries = allEntries.length
  for (const entry of allEntries) {
    checkedFiles++
    const actualFileName =
      actualZipByLowerName.get(entry.relativePath.toLowerCase()) ||
      entry.relativePath
    const zipPath = path.join(extractDir, actualFileName)

    onProgress?.({
      currentFile: entry.relativePath,
      checkedCount: checkedFiles,
      totalFiles: totalEntries,
    })

    if (!fs.existsSync(zipPath)) {
      failures.push({
        file: entry.relativePath,
        expected: entry.expectedCrc,
        reason: '文件不存在',
      })
      continue
    }

    const actualCrc = await computeFileCrc32(zipPath)

    if (actualCrc !== entry.expectedCrc) {
      failures.push({
        file: entry.relativePath,
        expected: entry.expectedCrc,
        actual: actualCrc,
        reason: 'CRC32 不匹配',
      })
      continue
    }

    try {
      await openZipForVerify(zipPath)
    } catch (err) {
      failures.push({
        file: entry.relativePath,
        reason: `ZIP 结构损坏: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return { passed: failures.length === 0, checkedFiles, failures }
}

// ============ 报告格式化 ============

export function formatIntegrityReport(result: IntegrityCheckResult): string {
  if (result.passed) {
    return `完整性检测通过: 已检查 ${result.checkedFiles} 个文件`
  }

  const lines = result.failures.map((f) => {
    let msg = `  - ${f.file}: ${f.reason}`
    if (f.expected && f.actual) {
      msg += ` (期望: ${f.expected}, 实际: ${f.actual})`
    }
    return msg
  })

  return `完整性检测失败：发现 ${result.failures.length} 个问题，已检查 ${result.checkedFiles} 个文件\n${lines.join('\n')}`
}

// ============ 辅助函数 ============

export function openZipForVerify(zipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err || new Error('无法打开 ZIP 文件'))
        return
      }
      zipfile.close()
      resolve()
    })
  })
}
