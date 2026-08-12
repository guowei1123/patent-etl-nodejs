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

  const entries = fs.readdirSync(dirPath).filter((f) => {
    const lower = f.toLowerCase()
    return (
      lower.endsWith('.zip') ||
      /^\.(z|zip)\d+$/.test(lower.substring(lower.lastIndexOf('.'))) ||
      /^\.z\d+$/.test(lower.substring(lower.lastIndexOf('.')))
    )
  })

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

    if (!hasMainZip) {
      failures.push({ file: `${baseName}.zip`, reason: '主 ZIP 文件不存在' })
      continue
    }

    checkedFiles++

    // 检查分卷文件大小一致性
    if (splitParts.length > 0) {
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

      checkedFiles += splitParts.length
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
  const actualZipFiles = allFiles.filter((f) => f.toUpperCase().endsWith('.ZIP'))
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

  return `完整性检测失败 (${result.failures.length}/${result.checkedFiles}):\n${lines.join('\n')}`
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
