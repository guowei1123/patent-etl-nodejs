import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import { promisify } from 'util'
import { StringDecoder } from 'string_decoder'
import yauzl from 'yauzl'

const gunzip = promisify(zlib.gunzip)

// 临时文件目录
const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), 'data')

export function ensureTempDir(): string {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true })
  }
  return TEMP_DIR
}

export function getTempPath(subdir?: string): string {
  const base = ensureTempDir()
  if (subdir) {
    const fullPath = path.join(base, subdir)
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true })
    }
    return fullPath
  }
  return base
}

export function cleanTempDir(subdir?: string): void {
  const targetPath = subdir ? path.join(TEMP_DIR, subdir) : TEMP_DIR
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true })
  }
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

    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err || new Error('无法打开ZIP文件'))
        return
      }

      zipfile.readEntry()

      zipfile.on('entry', (entry) => {
        const fileName = entry.fileName

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
    })
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

    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err || new Error('无法打开ZIP文件'))
        return
      }

      zipfile.readEntry()

      zipfile.on('entry', (entry) => {
        // 跳过目录
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry()
          return
        }

        // 应用过滤器
        if (filter && !filter(entry.fileName)) {
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
              await handler(entry.fileName, content)
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
    })
  })
}
