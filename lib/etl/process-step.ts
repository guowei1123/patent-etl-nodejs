import * as fs from 'fs'
import * as path from 'path'
import {
  extractFiles,
  forEachZipEntryBuffer,
  getTempPath,
  isPatentImageFile,
  isPatentXmlFile,
  withPreparedArchiveFiles,
} from '../file-processor'
import {
  formatIntegrityReport,
  openZipForVerify,
  verifyExtractedFilesCrc,
} from '../integrity'
import { parsePatentXml } from '../xml-parser'
import {
  addLog,
  getBatchByCode,
  updateBatchProgress,
  updateBatchStatus,
} from '../db'
import {
  buildPatentImageKey,
  isOssConfigured,
  putPatentImage,
} from '../oss-client'
import type { ParsedPatent, PatentType } from '@/types'
import type { StepResult } from './types'
import { runningTasks } from './task-state'

type ZipImageEntry = {
  fileName: string
  contentType: string
  size: number
  width?: number
  height?: number
}

type PatentImageReference = {
  patent: ParsedPatent
  isAbstract: boolean
}

function getImageMapKey(fileName: string): string {
  return path.basename(fileName).toLowerCase()
}

function getImageContentType(fileName: string): string {
  return fileName.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/jpeg'
}

function getJpegDimensions(content: Buffer): {
  width?: number
  height?: number
} {
  if (content.length < 4 || content[0] !== 0xff || content[1] !== 0xd8) {
    return {}
  }

  let offset = 2
  while (offset + 9 < content.length) {
    if (content[offset] !== 0xff) {
      offset++
      continue
    }

    const marker = content[offset + 1]
    if (marker === 0xd9 || marker === 0xda) break
    const length = content.readUInt16BE(offset + 2)
    if (length < 2) break

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isStartOfFrame && offset + 8 < content.length) {
      return {
        height: content.readUInt16BE(offset + 5),
        width: content.readUInt16BE(offset + 7),
      }
    }

    offset += 2 + length
  }

  return {}
}

function getReferencedImageKeys(patent: ParsedPatent): Set<string> {
  const referencedFiles = new Set<string>()
  for (const fileName of patent.image_files || []) {
    referencedFiles.add(getImageMapKey(fileName))
  }
  if (patent.abstract_figure) {
    referencedFiles.add(getImageMapKey(patent.abstract_figure))
  }
  return referencedFiles
}

function addPatentImageReferences(
  referencesByName: Map<string, PatentImageReference[]>,
  patent: ParsedPatent,
): void {
  const abstractKey = patent.abstract_figure
    ? getImageMapKey(patent.abstract_figure)
    : null

  for (const imageKey of getReferencedImageKeys(patent)) {
    const refs = referencesByName.get(imageKey) || []
    refs.push({
      patent,
      isAbstract: abstractKey === imageKey,
    })
    referencesByName.set(imageKey, refs)
  }
}

async function attachPatentImage(
  batchCode: string,
  reference: PatentImageReference,
  image: ZipImageEntry,
  content: Buffer,
): Promise<void> {
  const ossKey = buildPatentImageKey(
    batchCode,
    reference.patent.patent_number,
    image.fileName,
  )
  await putPatentImage(ossKey, content, image.contentType)

  const patentImages = reference.patent.images || []
  patentImages.push({
    file_name: path.basename(image.fileName),
    oss_key: ossKey,
    content_type: image.contentType,
    size: image.size,
    width: image.width,
    height: image.height,
    is_abstract: reference.isAbstract,
  })
  reference.patent.images = patentImages
}

async function uploadReferencedPatentImages(
  batchCode: string,
  zipFile: string,
  referencesByName: Map<string, PatentImageReference[]>,
): Promise<{ uploadedCount: number; processed: number; skipped: number }> {
  let uploadedCount = 0

  const result = await forEachZipEntryBuffer(
    zipFile,
    async (fileName, content) => {
      const imageKey = getImageMapKey(fileName)
      const references = referencesByName.get(imageKey)
      if (!references || !isPatentImageFile(fileName)) return

      const image: ZipImageEntry = {
        fileName,
        contentType: getImageContentType(fileName),
        size: content.length,
        ...getJpegDimensions(content),
      }

      for (const reference of references) {
        await attachPatentImage(batchCode, reference, image, content)
        uploadedCount++
      }
    },
    (fileName) =>
      isPatentImageFile(fileName) &&
      referencesByName.has(getImageMapKey(fileName)),
  )

  for (const references of referencesByName.values()) {
    for (const { patent } of references) {
      if (!patent.images) continue
      patent.images.sort((a, b) => {
        if (a.is_abstract !== b.is_abstract) return a.is_abstract ? -1 : 1
        return a.file_name.localeCompare(b.file_name)
      })
    }
  }

  return { uploadedCount, ...result }
}

export async function runProcessStep(batchCode: string): Promise<StepResult> {
  const batch = await getBatchByCode(batchCode)
  if (!batch) return { success: false, batchCode, error: '批次不存在' }
  if (batch.status !== 'downloaded') {
    return {
      success: false,
      batchCode,
      error: `当前状态 ${batch.status} 不可执行处理，需要 downloaded`,
    }
  }

  let cancelled = false
  runningTasks.set(batchCode, {
    cancel: () => {
      cancelled = true
    },
    cancelling: false,
  })

  try {
    await updateBatchStatus(batchCode, 'processing')
    await addLog(batchCode, 'info', '开始处理步骤')

    const tempPath = getTempPath(batchCode)
    const extractDir = getTempPath(`${batchCode}/extracted`)

    // === 阶段 1：外层解压（内层 ZIP 仍写磁盘，用于 CRC 校验） ===

    let innerZips = fs.existsSync(extractDir)
      ? fs
          .readdirSync(extractDir)
          .filter((f) => f.toUpperCase().endsWith('.ZIP'))
      : []

    // 跳过解压前验证已有内层 ZIP 的结构完整性
    if (innerZips.length > 0) {
      let allValid = true
      for (const f of innerZips) {
        try {
          await openZipForVerify(path.join(extractDir, f))
        } catch {
          allValid = false
          break
        }
      }
      if (!allValid) {
        await addLog(
          batchCode,
          'warn',
          '已解压文件中存在损坏的 ZIP，将重新解压',
        )
        fs.rmSync(extractDir, { recursive: true, force: true })
        fs.mkdirSync(extractDir, { recursive: true })
        innerZips = []
      }
    }

    if (innerZips.length === 0) {
      await withPreparedArchiveFiles(
        tempPath,
        async (filesToExtract) => {
          await addLog(
            batchCode,
            'info',
            `解压外层压缩包: ${filesToExtract.length} 个文件`,
          )

          await extractFiles(
            filesToExtract,
            extractDir,
            undefined,
            (current) => {
              updateBatchProgress(batchCode, undefined, current)
            },
          )
        },
        {
          beforeMerge: async (group) => {
            await addLog(
              batchCode,
              'info',
              `合并分卷 ZIP: ${group.baseName} (${group.splitParts.length + 1} 个文件)`,
            )
          },
        },
      )

      innerZips = fs
        .readdirSync(extractDir)
        .filter((f) => f.toUpperCase().endsWith('.ZIP'))
    }

    if (cancelled) throw new Error('任务已取消')

    // === 阶段 2：CRC 校验（验证内层 ZIP 完整性） ===

    await runExtractedFilesVerification(batchCode, extractDir)

    if (innerZips.length === 0) {
      throw new Error('未找到内层 ZIP 文件')
    }

    // === 阶段 3：流式解析 XML（不写磁盘） ===

    await addLog(batchCode, 'info', `流式解析 ${innerZips.length} 个内层 ZIP`)

    if (!isOssConfigured()) {
      throw new Error('OSS 配置未设置，无法存储专利附图')
    }

    const patents: ParsedPatent[] = []
    const patentType = batch.data_type as PatentType
    let uploadedImageCount = 0

    for (let i = 0; i < innerZips.length; i++) {
      if (cancelled) throw new Error('任务已取消')

      const zipFile = path.join(extractDir, innerZips[i])
      const zipPatents: ParsedPatent[] = []
      const referencesByName = new Map<string, PatentImageReference[]>()
      const xmlResult = await forEachZipEntryBuffer(
        zipFile,
        (fileName, content) => {
          const patent = parsePatentXml(content.toString('utf-8'), patentType)
          if (patent) {
            patent.source_file = fileName
            patents.push(patent)
            zipPatents.push(patent)
            addPatentImageReferences(referencesByName, patent)
          }
        },
        isPatentXmlFile,
      )
      const imageResult = await uploadReferencedPatentImages(
        batchCode,
        zipFile,
        referencesByName,
      )
      const zipUploadedCount = imageResult.uploadedCount
      uploadedImageCount += zipUploadedCount

      await addLog(
        batchCode,
        'info',
        `${innerZips[i]}: ${xmlResult.processed} 个 XML 处理, ${imageResult.processed} 张引用附图处理, ${zipPatents.length} 条专利, ${zipUploadedCount} 张附图上传, ${patents.length} 条累计专利`,
      )
      updateBatchProgress(batchCode, undefined, i + 1)
    }

    if (patents.length === 0) {
      throw new Error('未解析到任何专利数据')
    }

    // 将解析结果写入中间文件，供导入步骤使用
    // 清除冗余的 description（与 description_structured 内容重复），避免 parsed.json 超过 V8 字符串上限
    for (const p of patents) {
      if (p.description_structured) {
        p.description = undefined
      }
    }
    const parsedPath = path.join(tempPath, 'parsed.json')
    fs.writeFileSync(parsedPath, JSON.stringify(patents))

    await updateBatchProgress(batchCode, undefined, undefined, patents.length)
    await updateBatchStatus(batchCode, 'processed')
    await addLog(
      batchCode,
      'info',
      `处理完成: ${patents.length} 条专利数据, ${uploadedImageCount} 张附图上传`,
    )

    return {
      success: true,
      batchCode,
      details: {
        totalPatents: patents.length,
        innerZips: innerZips.length,
        uploadedImages: uploadedImageCount,
      },
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'
    await updateBatchStatus(batchCode, 'failed', errorMessage)
    await addLog(batchCode, 'error', `处理失败: ${errorMessage}`)
    return { success: false, batchCode, error: errorMessage }
  } finally {
    runningTasks.delete(batchCode)
  }
}

// 解压完成后自动校验内层 ZIP 的 CRC 和结构完整性。
export async function runExtractedFilesVerification(
  batchCode: string,
  extractDir: string,
): Promise<void> {
  const extractCheck = await verifyExtractedFilesCrc(extractDir)
  await addLog(
    batchCode,
    extractCheck.passed ? 'info' : 'error',
    extractCheck.passed
      ? `[自动校验] 解压文件 CRC 通过: ${extractCheck.checkedFiles} 个文件`
      : `[自动校验] 解压文件 CRC 失败: ${extractCheck.failures.length} 个问题`,
    extractCheck.passed ? undefined : { failures: extractCheck.failures },
  )
  if (!extractCheck.passed) {
    throw new Error(
      `CRC 完整性检测失败:\n${formatIntegrityReport(extractCheck)}`,
    )
  }
}
