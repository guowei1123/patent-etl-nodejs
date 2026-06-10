import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import { promisify } from 'util'
import { StringDecoder } from 'string_decoder'
import yauzl from 'yauzl'
export {
  cleanTempDir,
  ensureTempDir,
  getTempDirState,
  getTempPath,
  resolveTempPath,
} from './temp-dir'

const gunzip = promisify(zlib.gunzip)

// 分卷 ZIP 归档组
export interface SplitArchiveGroup {
  baseName: string
  isSplit: boolean
  mainZip: string
  splitParts: string[]
  allFiles: string[]
}

// 解压 .gz 文件
export async function extractGzip(
  inputPath: string,
  outputPath?: string,
): Promise<string> {
  const input = fs.readFileSync(inputPath)
  const output = await gunzip(input)

  const targetPath = outputPath || inputPath.replace(/\.gz$/, '')
  fs.writeFileSync(targetPath, output)

  return targetPath
}

// 解码 entry 文件名（yauzl decodeStrings:false 模式下 fileName 为 Buffer，绕过绝对路径校验）
function decodeFileName(entry: yauzl.Entry): string {
  const raw = entry.fileName as unknown as Buffer | string
  if (Buffer.isBuffer(raw)) {
    const isUtf8 = (entry.generalPurposeBitFlag & 0x800) !== 0
    return raw.toString(isUtf8 ? 'utf-8' : 'latin1')
  }
  return raw
}

// 解压 .zip 文件
export async function extractZip(
  zipPath: string,
  outputDir: string,
  filter?: (fileName: string) => boolean,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const extractedFiles: string[] = []

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // decodeStrings:false 绕过 yauzl 对绝对路径文件名的校验
    yauzl.open(
      zipPath,
      { lazyEntries: true, decodeStrings: false },
      (err, zipfile) => {
        if (err || !zipfile) {
          reject(err || new Error('无法打开ZIP文件'))
          return
        }

        zipfile.readEntry()

        zipfile.on('entry', (entry) => {
          const fileName = decodeFileName(entry)

          // 跳过目录
          if (/\/$/.test(fileName)) {
            zipfile.readEntry()
            return
          }

          // 应用过滤器
          if (filter && !filter(fileName)) {
            zipfile.readEntry()
            return
          }

          const outputPath = path.join(outputDir, path.basename(fileName))

          zipfile.openReadStream(entry, (err, readStream) => {
            if (err || !readStream) {
              zipfile.readEntry()
              return
            }

            const writeStream = fs.createWriteStream(outputPath)
            readStream.pipe(writeStream)

            writeStream.on('close', () => {
              extractedFiles.push(outputPath)
              zipfile.readEntry()
            })

            writeStream.on('error', () => {
              zipfile.readEntry()
            })
          })
        })

        zipfile.on('end', () => {
          resolve(extractedFiles)
        })

        zipfile.on('error', (err) => {
          reject(err)
        })
      },
    )
  })
}

// 智能解压：根据文件扩展名选择解压方法
export async function extractFile(
  filePath: string,
  outputDir: string,
  filter?: (fileName: string) => boolean,
): Promise<string[]> {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.zip') {
    return extractZip(filePath, outputDir, filter)
  } else if (ext === '.gz') {
    const extracted = await extractGzip(
      filePath,
      path.join(outputDir, path.basename(filePath, '.gz')),
    )

    // 如果解压后仍然是压缩文件，递归解压
    const newExt = path.extname(extracted).toLowerCase()
    if (newExt === '.zip') {
      return extractZip(extracted, outputDir, filter)
    }

    return [extracted]
  }

  // 不是压缩文件，直接返回
  return [filePath]
}

// 批量解压文件
export async function extractFiles(
  filePaths: string[],
  outputDir: string,
  filter?: (fileName: string) => boolean,
  onProgress?: (current: number, total: number, fileName: string) => void,
): Promise<string[]> {
  const allExtracted: string[] = []
  const failedFiles: string[] = []

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i]

    if (onProgress) {
      onProgress(i + 1, filePaths.length, path.basename(filePath))
    }

    try {
      const extracted = await extractFile(filePath, outputDir, filter)
      allExtracted.push(...extracted)
    } catch (error) {
      console.error(`解压文件失败 ${filePath}:`, error)
      failedFiles.push(path.basename(filePath))
    }
  }

  if (failedFiles.length > 0) {
    throw new Error(`解压失败文件: ${failedFiles.join(', ')}`)
  }

  return allExtracted
}

// 查找目录中的所有 XML 文件
export function findXmlFiles(dir: string): string[] {
  const xmlFiles: string[] = []

  function walkDir(currentPath: string) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name)

      if (entry.isDirectory()) {
        walkDir(fullPath)
      } else if (entry.isFile() && /\.xml$/i.test(entry.name)) {
        xmlFiles.push(fullPath)
      }
    }
  }

  if (fs.existsSync(dir)) {
    walkDir(dir)
  }

  return xmlFiles
}

// 获取文件大小（人类可读格式）
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let unitIndex = 0
  let size = bytes

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`
}

// 扫描目录中的压缩文件（ZIP、分卷 ZIP），用于跳过下载时构建文件列表
export function scanLocalArchiveFiles(dirPath: string): string[] {
  const files: string[] = []

  if (!fs.existsSync(dirPath)) return files

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile()) {
      const name = entry.name.toLowerCase()
      if (
        name.endsWith('.zip') ||
        name.endsWith('.gz') ||
        name.endsWith('.xml') ||
        /^\.z\d+$/.test(name.substring(name.lastIndexOf('.')))
      ) {
        files.push(path.join(dirPath, entry.name))
      }
    }
  }

  return files
}

// 扫描目录，按基础名分组压缩文件，区分独立 ZIP 和分卷 ZIP
export function groupArchiveFiles(dirPath: string): SplitArchiveGroup[] {
  if (!fs.existsSync(dirPath)) return []

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  const fileMap = new Map<string, Map<string, string>>() // baseName -> ext -> fullPath

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const name = entry.name
    const lower = name.toLowerCase()
    const dotIdx = lower.lastIndexOf('.')
    if (dotIdx < 0) continue
    const ext = lower.substring(dotIdx)

    const isZip = ext === '.zip'
    const isSplit = /^\.z\d{1,2}$/.test(ext)
    const isGz = ext === '.gz'
    if (!isZip && !isSplit && !isGz) continue
    // Skip stale merged files from previous failed runs
    if (isZip && lower.endsWith('.merged.zip')) continue

    let baseName: string
    if (isZip) {
      baseName = name.substring(0, name.length - 4)
    } else if (isSplit) {
      baseName = name.substring(0, name.length - ext.length)
    } else {
      baseName = name.substring(0, name.length - 3)
    }

    if (!fileMap.has(baseName)) fileMap.set(baseName, new Map())
    fileMap.get(baseName)!.set(ext, path.join(dirPath, name))
  }

  const groups: SplitArchiveGroup[] = []
  for (const [baseName, extMap] of fileMap) {
    const mainZip = extMap.get('.zip')
    const splitParts: string[] = []
    for (const [ext, fullPath] of extMap) {
      if (/^\.z\d+$/.test(ext)) splitParts.push(fullPath)
    }
    splitParts.sort((a, b) => {
      const numA = parseInt(a.substring(a.lastIndexOf('.') + 2), 10)
      const numB = parseInt(b.substring(b.lastIndexOf('.') + 2), 10)
      return numA - numB
    })

    const isSplit = splitParts.length > 0 && !!mainZip
    const allFiles = [
      ...splitParts,
      ...(mainZip ? [mainZip] : []),
      ...(extMap.get('.gz') ? [extMap.get('.gz')!] : []),
    ]

    if (mainZip) {
      groups.push({ baseName, isSplit, mainZip, splitParts, allFiles })
    }
    // .gz without corresponding .zip — treat as standalone
    if (!mainZip && extMap.has('.gz')) {
      const gzPath = extMap.get('.gz')!
      groups.push({
        baseName,
        isSplit: false,
        mainZip: gzPath,
        splitParts: [],
        allFiles: [gzPath],
      })
    }
  }

  return groups
}

// 合并分卷 ZIP 为单文件（按 z01 → z02 → ... → zip 顺序拼接）
export async function mergeSplitZip(
  group: SplitArchiveGroup,
  outputPath: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(outputPath)
    const orderedFiles = [...group.splitParts, group.mainZip]

    let fileIndex = 0

    function pipeNext() {
      if (fileIndex >= orderedFiles.length) {
        writeStream.end(() => resolve(outputPath))
        return
      }

      const readStream = fs.createReadStream(orderedFiles[fileIndex])
      readStream.on('error', reject)
      readStream.pipe(writeStream, { end: false })
      readStream.on('end', () => {
        fileIndex++
        pipeNext()
      })
    }

    writeStream.on('error', reject)
    pipeNext()
  })
}

// Patch 合并后的分卷 ZIP，修复所有 header 使 yauzl 可正常解压
// 需要修复：
//   1. Offset 0 的 spanning marker (0x08074b50) → local file header (0x04034b50)
//   2. EOCD disk number → 0
//   3. CD 偏移量调整（加上前置分卷大小），若超过 32-bit 则生成 Zip64 EOCD
//   4. 逐条修复 CD entry 的 local file header offset（加上所在分卷的累积偏移）
// zipDiskOffset = 所有前置分卷（.z01~.zNN）的字节总和
// splitPartSizes = 每个前置分卷的个体大小 [.z01, .z02, ...]，用于构建 disk→offset 映射
export async function patchMergedZipEOCD(
  filePath: string,
  zipDiskOffset = 0,
  splitPartSizes: number[] = [],
): Promise<void> {
  // Fix 1: Replace spanning marker at offset 0
  const headBuf = Buffer.alloc(4)
  const fd = await fs.promises.open(filePath, 'r+')
  try {
    await fd.read(headBuf, 0, 4, 0)
    if (headBuf.readUInt32LE(0) === 0x08074b50) {
      const lfhSig = Buffer.alloc(4)
      lfhSig.writeUInt32LE(0x04034b50, 0)
      await fd.write(lfhSig, 0, 4, 0)
    }
  } finally {
    await fd.close()
  }

  // Find the standard EOCD
  const { size } = await fs.promises.stat(filePath)
  const searchLen = Math.min(size, 65535 + 22)
  const searchBuf = Buffer.alloc(searchLen)
  const fd2 = await fs.promises.open(filePath, 'r+')
  try {
    await fd2.read(searchBuf, 0, searchLen, size - searchLen)

    let eocdIdx = -1
    for (let i = searchLen - 22; i >= 0; i--) {
      if (searchBuf.readUInt32LE(i) === 0x06054b50) {
        eocdIdx = i
        break
      }
    }
    if (eocdIdx === -1) {
      throw new Error('EOCD signature not found in merged ZIP')
    }

    const eocdFileOffset = size - searchLen + eocdIdx
    const entryCount = searchBuf.readUInt16LE(eocdIdx + 10)
    const origCdOffset = searchBuf.readUInt32LE(eocdIdx + 16)
    const commentLen = searchBuf.readUInt16LE(eocdIdx + 20)
    const comment =
      commentLen > 0
        ? Buffer.from(
            searchBuf.subarray(eocdIdx + 22, eocdIdx + 22 + commentLen),
          )
        : Buffer.alloc(0)

    // Determine the true CD offset (prefer Zip64 EOCD value when available)
    let cdOffset = origCdOffset
    let cdReadEnd = eocdFileOffset
    if (eocdIdx >= 20 && searchBuf.readUInt32LE(eocdIdx - 20) === 0x07064b50) {
      const zip64Offset = Number(searchBuf.readBigUInt64LE(eocdIdx - 20 + 8))
      const z64buf = Buffer.alloc(8)
      await fd2.read(z64buf, 0, 8, zip64Offset + 48)
      cdOffset = Number(z64buf.readBigUInt64LE(0))
      cdReadEnd = zip64Offset
    }
    const adjustedCdOffset = cdOffset + zipDiskOffset

    if (splitPartSizes.length > 0) {
      // --- Split archive: fix per-entry CD offsets + rewrite EOCD ---

      // Build disk-number-to-cumulative-offset map
      const diskOffsets = [0]
      let cumSum = 0
      for (const sz of splitPartSizes) {
        cumSum += sz
        diskOffsets.push(cumSum)
      }

      // Read all CD entries
      const cdEntryBufs: Buffer[] = []
      let readOff = adjustedCdOffset
      while (readOff < cdReadEnd) {
        const hdr = Buffer.alloc(46)
        await fd2.read(hdr, 0, 46, readOff)
        if (hdr.readUInt32LE(0) !== 0x02014b50) break

        const nLen = hdr.readUInt16LE(28)
        const eLen = hdr.readUInt16LE(30)
        const cLen = hdr.readUInt16LE(32)
        const entrySize = 46 + nLen + eLen + cLen

        const entryBuf = Buffer.alloc(entrySize)
        await fd2.read(entryBuf, 0, entrySize, readOff)
        cdEntryBufs.push(entryBuf)
        readOff += entrySize
      }

      // Adjust each entry's local file header offset
      const fixedEntries: Buffer[] = []
      for (const entry of cdEntryBufs) {
        const diskNum = entry.readUInt16LE(34)
        const relOff = entry.readUInt32LE(42)
        const diskBase = diskNum < diskOffsets.length ? diskOffsets[diskNum] : 0
        const absOff = diskBase + relOff

        entry.writeUInt16LE(0, 34) // zero disk number start

        if (absOff <= 0xffffffff) {
          entry.writeUInt32LE(absOff, 42)
          fixedEntries.push(entry)
        } else {
          // Need Zip64 extra field for the offset
          entry.writeUInt32LE(0xffffffff, 42)

          const nLen = entry.readUInt16LE(28)
          const eLen = entry.readUInt16LE(30)
          const cLen = entry.readUInt16LE(32)
          const extraStart = 46 + nLen

          // Check for existing Zip64 extra field
          let foundZip64 = false
          let ePos = extraStart
          while (ePos + 4 <= extraStart + eLen) {
            const tag = entry.readUInt16LE(ePos)
            const sz = entry.readUInt16LE(ePos + 2)
            if (tag === 0x0001) {
              // Zip64 extra data layout depends on which 32-bit fields overflowed:
              // [Original Size 8B] (if CD uncompressed == 0xFFFFFFFF)
              // [Compressed Size 8B] (if CD compressed == 0xFFFFFFFF)
              // [Header Offset 8B] (if CD offset == 0xFFFFFFFF)
              // [Disk Start 4B] (if CD disk start == 0xFFFF)
              // The original offset was relOff (< 4GB), so offset field was NOT present.
              // We must rebuild the Zip64 extra to include the offset.
              const uncompressedOverflow = entry.readUInt32LE(24) === 0xffffffff
              const compressedOverflow = entry.readUInt32LE(20) === 0xffffffff

              // Read existing overflow values to preserve them
              let readPos = ePos + 4
              const origUncompressed = uncompressedOverflow
                ? entry.readBigUInt64LE(readPos)
                : null
              if (uncompressedOverflow) readPos += 8
              const origCompressed = compressedOverflow
                ? entry.readBigUInt64LE(readPos)
                : null
              if (compressedOverflow) readPos += 8

              // Build new Zip64 extra data size
              let newZip64DataSize = 8 // offset (always needed)
              if (uncompressedOverflow) newZip64DataSize += 8
              if (compressedOverflow) newZip64DataSize += 8

              const sizeDiff = newZip64DataSize - sz
              const commentStart = extraStart + eLen

              if (sizeDiff <= 0) {
                // Fits in existing space — write in place
                let writePos = ePos + 4
                if (uncompressedOverflow) writePos += 8
                if (compressedOverflow) writePos += 8
                entry.writeBigUInt64LE(BigInt(absOff), writePos)
                entry.writeUInt16LE(newZip64DataSize, ePos + 2)
                fixedEntries.push(entry)
              } else {
                // Need to grow — rebuild entry with larger Zip64 extra
                const newExtraLen = eLen + sizeDiff
                const newEntry = Buffer.alloc(46 + nLen + newExtraLen + cLen)
                // Copy: header + filename + extra fields before this Zip64 block
                entry.copy(newEntry, 0, 0, ePos)
                // Write new Zip64 extra
                let writePos = ePos
                newEntry.writeUInt16LE(0x0001, writePos)
                newEntry.writeUInt16LE(newZip64DataSize, writePos + 2)
                writePos += 4
                if (uncompressedOverflow) {
                  newEntry.writeBigUInt64LE(origUncompressed!, writePos)
                  writePos += 8
                }
                if (compressedOverflow) {
                  newEntry.writeBigUInt64LE(origCompressed!, writePos)
                  writePos += 8
                }
                newEntry.writeBigUInt64LE(BigInt(absOff), writePos)
                writePos += 8
                // Copy: extra fields after the Zip64 block + comment
                const afterZip64 = ePos + 4 + sz
                if (afterZip64 < commentStart) {
                  entry.copy(newEntry, writePos, afterZip64, commentStart)
                }
                entry.copy(newEntry, 46 + nLen + newExtraLen, commentStart)
                newEntry.writeUInt16LE(newExtraLen, 30)
                newEntry.writeUInt16LE(0, 34)
                fixedEntries.push(newEntry)
              }

              foundZip64 = true
              break
            }
            ePos += 4 + sz
          }

          if (!foundZip64) {
            // Append Zip64 extra field (tag 2 + size 2 + offset 8 = 12 bytes)
            const zip64Extra = Buffer.alloc(12)
            zip64Extra.writeUInt16LE(0x0001, 0)
            zip64Extra.writeUInt16LE(8, 2)
            zip64Extra.writeBigUInt64LE(BigInt(absOff), 4)

            const commentStart = extraStart + eLen
            const newExtraLen = eLen + 12
            const newEntry = Buffer.alloc(46 + nLen + newExtraLen + cLen)
            entry.copy(newEntry, 0, 0, extraStart) // fixed header + filename
            entry.copy(newEntry, extraStart, extraStart, commentStart) // old extra
            zip64Extra.copy(newEntry, extraStart + eLen) // appended Zip64
            entry.copy(newEntry, extraStart + newExtraLen, commentStart) // comment
            newEntry.writeUInt16LE(newExtraLen, 30)
            newEntry.writeUInt16LE(0, 34)
            fixedEntries.push(newEntry)
          }
        }
      }

      // Write new CD section
      const cdBuf = Buffer.concat(fixedEntries)
      const newCdSize = cdBuf.length
      let writePos = adjustedCdOffset
      await fd2.write(cdBuf, 0, newCdSize, writePos)
      writePos += newCdSize

      // Write Zip64 EOCD (56 bytes)
      const zip64Eocd = Buffer.alloc(56)
      zip64Eocd.writeUInt32LE(0x06064b50, 0)
      zip64Eocd.writeBigUInt64LE(BigInt(44), 4)
      zip64Eocd.writeUInt16LE(45, 12)
      zip64Eocd.writeUInt16LE(45, 14)
      zip64Eocd.writeUInt32LE(0, 16)
      zip64Eocd.writeUInt32LE(0, 20)
      zip64Eocd.writeBigUInt64LE(BigInt(fixedEntries.length), 24)
      zip64Eocd.writeBigUInt64LE(BigInt(fixedEntries.length), 32)
      zip64Eocd.writeBigUInt64LE(BigInt(newCdSize), 40)
      zip64Eocd.writeBigUInt64LE(BigInt(adjustedCdOffset), 48)
      await fd2.write(zip64Eocd, 0, 56, writePos)
      writePos += 56

      // Write Zip64 Locator (20 bytes)
      const zip64Locator = Buffer.alloc(20)
      zip64Locator.writeUInt32LE(0x07064b50, 0)
      zip64Locator.writeUInt32LE(0, 4)
      zip64Locator.writeBigUInt64LE(BigInt(writePos - 56), 8)
      zip64Locator.writeUInt32LE(1, 16)
      await fd2.write(zip64Locator, 0, 20, writePos)
      writePos += 20

      // Write standard EOCD (22 + comment bytes)
      const newEocd = Buffer.alloc(22 + comment.length)
      newEocd.writeUInt32LE(0x06054b50, 0)
      newEocd.writeUInt16LE(0, 4)
      newEocd.writeUInt16LE(0, 6)
      newEocd.writeUInt16LE(
        fixedEntries.length > 0xffff ? 0xffff : fixedEntries.length,
        8,
      )
      newEocd.writeUInt16LE(
        fixedEntries.length > 0xffff ? 0xffff : fixedEntries.length,
        10,
      )
      newEocd.writeUInt32LE(0xffffffff, 12)
      newEocd.writeUInt32LE(0xffffffff, 16)
      newEocd.writeUInt16LE(comment.length, 20)
      if (comment.length > 0) comment.copy(newEocd, 22)
      await fd2.write(newEocd, 0, newEocd.length, writePos)
      writePos += newEocd.length

      await fd2.truncate(writePos)
    } else {
      // --- Non-split archive: original EOCD-only patching ---
      const adjustedCdOffset =
        zipDiskOffset > 0 ? origCdOffset + zipDiskOffset : origCdOffset
      let hasExistingZip64 = false
      if (
        eocdIdx >= 20 &&
        searchBuf.readUInt32LE(eocdIdx - 20) === 0x07064b50
      ) {
        hasExistingZip64 = true
        const zip64Offset = Number(searchBuf.readBigUInt64LE(eocdIdx - 20 + 8))
        await fd2.write(Buffer.alloc(8, 0), 0, 8, zip64Offset + 16)
        if (zipDiskOffset > 0) {
          const z64buf = Buffer.alloc(8)
          await fd2.read(z64buf, 0, 8, zip64Offset + 48)
          const orig = Number(z64buf.readBigUInt64LE(0))
          z64buf.writeBigUInt64LE(BigInt(orig + zipDiskOffset), 0)
          await fd2.write(z64buf, 0, 8, zip64Offset + 48)
        }
      }

      if (!hasExistingZip64 && adjustedCdOffset > 0xffffffff) {
        const truncateAt = eocdFileOffset
        const zip64Eocd = Buffer.alloc(56)
        zip64Eocd.writeUInt32LE(0x06064b50, 0)
        zip64Eocd.writeBigUInt64LE(BigInt(44), 4)
        zip64Eocd.writeUInt16LE(45, 12)
        zip64Eocd.writeUInt16LE(45, 14)
        zip64Eocd.writeUInt32LE(0, 16)
        zip64Eocd.writeUInt32LE(0, 20)
        zip64Eocd.writeBigUInt64LE(BigInt(entryCount), 24)
        zip64Eocd.writeBigUInt64LE(BigInt(entryCount), 32)
        zip64Eocd.writeBigUInt64LE(BigInt(0), 40)
        zip64Eocd.writeBigUInt64LE(BigInt(adjustedCdOffset), 48)

        const zip64Locator = Buffer.alloc(20)
        zip64Locator.writeUInt32LE(0x07064b50, 0)
        zip64Locator.writeUInt32LE(0, 4)
        zip64Locator.writeBigUInt64LE(BigInt(truncateAt), 8)
        zip64Locator.writeUInt32LE(1, 16)

        const newEocd = Buffer.alloc(22 + comment.length)
        newEocd.writeUInt32LE(0x06054b50, 0)
        newEocd.writeUInt16LE(0, 4)
        newEocd.writeUInt16LE(0, 6)
        newEocd.writeUInt16LE(entryCount > 0xffff ? 0xffff : entryCount, 8)
        newEocd.writeUInt16LE(entryCount > 0xffff ? 0xffff : entryCount, 10)
        newEocd.writeUInt32LE(0xffffffff, 12)
        newEocd.writeUInt32LE(0xffffffff, 16)
        newEocd.writeUInt16LE(comment.length, 20)
        if (comment.length > 0) comment.copy(newEocd, 22)

        await fd2.write(zip64Eocd, 0, 56, truncateAt)
        await fd2.write(zip64Locator, 0, 20, truncateAt + 56)
        await fd2.write(newEocd, 0, newEocd.length, truncateAt + 56 + 20)
        await fd2.truncate(truncateAt + 56 + 20 + newEocd.length)
      } else {
        await fd2.write(Buffer.alloc(4, 0), 0, 4, eocdFileOffset + 4)
        if (zipDiskOffset > 0) {
          const cdBuf = Buffer.alloc(4)
          cdBuf.writeUInt32LE(
            adjustedCdOffset > 0xffffffff ? 0xffffffff : adjustedCdOffset,
            0,
          )
          await fd2.write(cdBuf, 0, 4, eocdFileOffset + 16)
        }
      }
    }
  } finally {
    await fd2.close()
  }
}

interface PreparedArchiveOptions {
  beforeMerge?: (
    group: SplitArchiveGroup,
    outputPath: string,
  ) => void | Promise<void>
  mergeArchive?: (
    group: SplitArchiveGroup,
    outputPath: string,
  ) => Promise<string>
}

// 准备外层压缩包用于解压，并确保合并产生的临时文件总会被清理
export async function withPreparedArchiveFiles<T>(
  dirPath: string,
  handler: (filePaths: string[]) => Promise<T>,
  options: PreparedArchiveOptions = {},
): Promise<T> {
  const { beforeMerge, mergeArchive = mergeSplitZip } = options

  if (!fs.existsSync(dirPath)) {
    throw new Error('未找到可解压的下载文件')
  }

  for (const fileName of fs.readdirSync(dirPath)) {
    if (!fileName.toLowerCase().endsWith('.merged.zip')) continue
    try {
      fs.unlinkSync(path.join(dirPath, fileName))
    } catch {}
  }

  const groups = groupArchiveFiles(dirPath)
  const filesToExtract: string[] = []
  const mergedFiles: string[] = []

  try {
    for (const group of groups) {
      if (group.isSplit) {
        const mergedPath = path.join(dirPath, `${group.baseName}.merged.zip`)
        mergedFiles.push(mergedPath)
        await beforeMerge?.(group, mergedPath)
        await mergeArchive(group, mergedPath)
        // Calculate individual and cumulative sizes of preceding split parts
        const splitPartSizes = group.splitParts.map((p) => fs.statSync(p).size)
        const zipDiskOffset = splitPartSizes.reduce((sum, s) => sum + s, 0)
        await patchMergedZipEOCD(mergedPath, zipDiskOffset, splitPartSizes)
        filesToExtract.push(mergedPath)
      } else if (group.mainZip.toLowerCase().endsWith('.zip')) {
        filesToExtract.push(group.mainZip)
      } else if (group.mainZip.toLowerCase().endsWith('.gz')) {
        filesToExtract.push(group.mainZip)
      }
    }

    if (filesToExtract.length === 0) {
      throw new Error('未找到可解压的下载文件')
    }

    return await handler(filesToExtract)
  } finally {
    for (const merged of mergedFiles) {
      try {
        fs.unlinkSync(merged)
      } catch {}
    }
  }
}

// 检查文件是否是专利 XML 文件
export function isPatentXmlFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase()
  return (
    lowerName.endsWith('.xml') &&
    !lowerName.includes('dtd') &&
    !lowerName.includes('xsd') &&
    !lowerName.includes('schema')
  )
}

// 流式遍历 ZIP 中的文件 entry，将内容收集为字符串后回调，不写磁盘
export async function forEachZipEntry(
  zipPath: string,
  handler: (fileName: string, content: string) => void | Promise<void>,
  filter?: (fileName: string) => boolean,
): Promise<{ processed: number; skipped: number }> {
  return new Promise((resolve, reject) => {
    let processed = 0
    let skipped = 0

    yauzl.open(
      zipPath,
      { lazyEntries: true, decodeStrings: false },
      (err, zipfile) => {
        if (err || !zipfile) {
          reject(err || new Error('无法打开ZIP文件'))
          return
        }

        zipfile.readEntry()

        zipfile.on('entry', (entry) => {
          const fileName = decodeFileName(entry)

          // 跳过目录
          if (/\/$/.test(fileName)) {
            zipfile.readEntry()
            return
          }

          // 应用过滤器
          if (filter && !filter(fileName)) {
            skipped++
            zipfile.readEntry()
            return
          }

          zipfile.openReadStream(entry, async (err, readStream) => {
            if (err || !readStream) {
              skipped++
              zipfile.readEntry()
              return
            }

            // 收集流数据为字符串
            const decoder = new StringDecoder('utf-8')
            const chunks: string[] = []

            readStream.on('data', (chunk: Buffer) => {
              chunks.push(decoder.write(chunk))
            })

            readStream.on('end', async () => {
              chunks.push(decoder.end())
              const content = chunks.join('')

              try {
                await handler(fileName, content)
                processed++
              } catch {
                skipped++
              }

              zipfile.readEntry()
            })

            readStream.on('error', () => {
              skipped++
              zipfile.readEntry()
            })
          })
        })

        zipfile.on('end', () => {
          resolve({ processed, skipped })
        })

        zipfile.on('error', (err) => {
          reject(err)
        })
      },
    )
  })
}
