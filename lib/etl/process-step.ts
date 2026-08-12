import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
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
  patentImageExists,
  putPatentImage,
} from '../oss-client'
import type {
  ParsedPatent,
  ParsedPatentImageReference,
  PatentType,
} from '@/types'
import type { StepResult } from './types'
import {
  clearProcessProgress,
  patchProcessProgress,
  runningTasks,
  setProcessProgress,
} from './task-state'
import { filterPatents } from '../filter-config'
import {
  buildImageKey,
  matchPatentAbstractToDrawing,
} from '../patent-image-matcher'

type ZipImageEntry = {
  fileName: string
  contentHash: string
  perceptualHash?: string
  contentType: string
  size: number
  width?: number
  height?: number
}

type PatentImageReference = {
  patent: ParsedPatent
  imageKey: string
  isAbstract: boolean
  imageRole: 'abstract' | 'drawing' | 'inline'
  figureLabel?: string
  sourceSection?: string
}

type ReferencedZipImage = {
  image: ZipImageEntry
  content: Buffer
}

type ImageAssetMatch = {
  canonicalImageKey: string
  displayRotation: number
  matchMethod?: string
  matchScore?: number
  matchedFileName?: string
}

type ImageUploadResult = 'uploaded' | 'skipped'

type ImageUploadFailure = {
  fileName: string
  patentNumber: string
  ossKey: string
  error: string
}

type ImageUploadStats = {
  total: number
  uploaded: number
  skipped: number
  failed: number
}

type ProcessZipCheckpoint = {
  version: 1
  zipName: string
  zipSize: number
  zipMtimeMs: number
  uploadImages: boolean
  xmlProcessed: number
  filteredOut: number
  uploadedImages: number
  skippedImages: number
  patents: ParsedPatent[]
}

const PROCESS_CHECKPOINT_VERSION = 1

function getImageUploadConcurrency(): number {
  const value = parseInt(process.env.IMAGE_UPLOAD_CONCURRENCY || '8', 10)
  return Number.isFinite(value) && value > 0 ? value : 8
}

function getImageUploadLogInterval(): number {
  const value = parseInt(process.env.IMAGE_UPLOAD_LOG_INTERVAL || '200', 10)
  return Number.isFinite(value) && value > 0 ? value : 200
}

function shouldUploadImagesDuringProcess(): boolean {
  return process.env.PROCESS_UPLOAD_IMAGES !== '0'
}

function getImageMapKey(fileName: string): string {
  return buildImageKey(fileName)
}

function getImageContentType(fileName: string): string {
  const lowerName = fileName.toLowerCase()
  if (lowerName.endsWith('.png')) return 'image/png'
  if (lowerName.endsWith('.gif')) return 'image/gif'
  if (lowerName.endsWith('.bmp')) return 'image/bmp'
  if (lowerName.endsWith('.webp')) return 'image/webp'
  if (lowerName.endsWith('.tif') || lowerName.endsWith('.tiff'))
    return 'image/tiff'
  if (lowerName.endsWith('.jp2') || lowerName.endsWith('.j2k'))
    return 'image/jp2'
  if (lowerName.endsWith('.svg')) return 'image/svg+xml'
  return 'image/jpeg'
}

function getImageContentHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function getProcessCheckpointDir(tempPath: string): string {
  return path.join(tempPath, 'process-checkpoints')
}

function getProcessCheckpointPath(tempPath: string, zipName: string): string {
  return path.join(
    getProcessCheckpointDir(tempPath),
    `${encodeURIComponent(zipName)}.json`,
  )
}

function getZipFileSignature(zipFile: string): {
  zipSize: number
  zipMtimeMs: number
} {
  const stat = fs.statSync(zipFile)
  return {
    zipSize: stat.size,
    zipMtimeMs: stat.mtimeMs,
  }
}

function preparePatentsForParsedOutput(patents: ParsedPatent[]): void {
  for (const patent of patents) {
    if (patent.description_structured) {
      patent.description = undefined
    }
  }
}

function readProcessZipCheckpoint(
  tempPath: string,
  zipFile: string,
  uploadImages: boolean,
): ProcessZipCheckpoint | null {
  const zipName = path.basename(zipFile)
  const checkpointPath = getProcessCheckpointPath(tempPath, zipName)
  if (!fs.existsSync(checkpointPath)) return null

  try {
    const checkpoint = JSON.parse(
      fs.readFileSync(checkpointPath, 'utf-8'),
    ) as Partial<ProcessZipCheckpoint>
    const signature = getZipFileSignature(zipFile)

    if (
      checkpoint.version !== PROCESS_CHECKPOINT_VERSION ||
      checkpoint.zipName !== zipName ||
      checkpoint.zipSize !== signature.zipSize ||
      checkpoint.zipMtimeMs !== signature.zipMtimeMs ||
      checkpoint.uploadImages !== uploadImages ||
      !Array.isArray(checkpoint.patents)
    ) {
      return null
    }

    return checkpoint as ProcessZipCheckpoint
  } catch {
    return null
  }
}

function writeProcessZipCheckpoint(
  tempPath: string,
  zipFile: string,
  checkpoint: Omit<
    ProcessZipCheckpoint,
    'version' | 'zipName' | 'zipSize' | 'zipMtimeMs'
  >,
): void {
  const zipName = path.basename(zipFile)
  const signature = getZipFileSignature(zipFile)
  const checkpointDir = getProcessCheckpointDir(tempPath)
  fs.mkdirSync(checkpointDir, { recursive: true })

  const checkpointPath = getProcessCheckpointPath(tempPath, zipName)
  const tempCheckpointPath = `${checkpointPath}.${process.pid}.tmp`
  fs.writeFileSync(
    tempCheckpointPath,
    JSON.stringify({
      version: PROCESS_CHECKPOINT_VERSION,
      zipName,
      ...signature,
      ...checkpoint,
    } satisfies ProcessZipCheckpoint),
  )
  fs.renameSync(tempCheckpointPath, checkpointPath)
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

function addReference(
  referencesByName: Map<string, PatentImageReference[]>,
  patent: ParsedPatent,
  imageKey: string,
  reference: Omit<PatentImageReference, 'patent' | 'imageKey'>,
): void {
  const refs = referencesByName.get(imageKey) || []
  refs.push({ patent, imageKey, ...reference })
  referencesByName.set(imageKey, refs)
}

function getImageReferenceKey(reference: ParsedPatentImageReference): string {
  return getImageMapKey(reference.file_name)
}

function addPatentImageReferences(
  referencesByName: Map<string, PatentImageReference[]>,
  patent: ParsedPatent,
): void {
  const abstractKey = patent.abstract_figure
    ? getImageMapKey(patent.abstract_figure)
    : null
  const referencedKeys = new Set<string>()

  for (const reference of patent.image_references || []) {
    const imageKey = getImageReferenceKey(reference)
    referencedKeys.add(imageKey)
    addReference(referencesByName, patent, imageKey, {
      isAbstract: false,
      imageRole: reference.image_role,
      figureLabel: reference.figure_label,
      sourceSection: reference.source_section,
    })
  }

  for (const fileName of patent.image_files || []) {
    const imageKey = getImageMapKey(fileName)
    if (referencedKeys.has(imageKey)) continue
    addReference(referencesByName, patent, imageKey, {
      isAbstract: abstractKey === imageKey,
      imageRole: abstractKey === imageKey ? 'abstract' : 'drawing',
    })
  }

  if (abstractKey) {
    addReference(referencesByName, patent, abstractKey, {
      isAbstract: true,
      imageRole: 'abstract',
    })
  }
}

async function attachPatentImage(
  batchCode: string,
  reference: PatentImageReference,
  usageImage: ZipImageEntry,
  assetImage: ZipImageEntry,
  assetContent: Buffer,
  assetKeyByPatentHash: Map<string, string>,
  match?: ImageAssetMatch,
): Promise<{ ossKey: string; result: ImageUploadResult }> {
  const patentHashKey =
    reference.patent.patent_number + '\u0000' + assetImage.contentHash
  const existingAssetKey = assetKeyByPatentHash.get(patentHashKey)
  const ossKey =
    existingAssetKey ||
    buildPatentImageKey(
      batchCode,
      reference.patent.patent_number,
      assetImage.fileName,
    )

  let exists = false
  if (!existingAssetKey) {
    exists = await patentImageExists(ossKey)
    if (!exists) {
      await putPatentImage(ossKey, assetContent, assetImage.contentType)
    }
    assetKeyByPatentHash.set(patentHashKey, ossKey)
  }

  const patentImages = reference.patent.images || []
  patentImages.push({
    file_name: path.basename(usageImage.fileName),
    oss_key: ossKey,
    content_hash: assetImage.contentHash,
    perceptual_hash: assetImage.perceptualHash,
    content_type: assetImage.contentType,
    size: assetImage.size,
    width: assetImage.width,
    height: assetImage.height,
    is_abstract: reference.isAbstract,
    image_role: reference.imageRole,
    figure_label: reference.figureLabel,
    source_section: reference.sourceSection,
    display_rotation: match?.displayRotation || 0,
    match_method: match?.matchMethod,
    match_score: match?.matchScore,
    matched_file_name: match?.matchedFileName,
  })
  reference.patent.images = patentImages

  return { ossKey, result: existingAssetKey || exists ? 'skipped' : 'uploaded' }
}

function getDrawingImageKeys(patent: ParsedPatent): string[] {
  const drawingRefs = (patent.image_references || [])
    .filter((reference) => reference.image_role === 'drawing')
    .map((reference) => getImageMapKey(reference.file_name))
  if (drawingRefs.length > 0) return drawingRefs
  return (patent.image_files || []).map((fileName) => getImageMapKey(fileName))
}
function getPatentImageMatchKey(
  patentNumber: string,
  imageKey: string,
): string {
  return patentNumber + '\u0000' + imageKey
}

function toMatcherImage(entry: ReferencedZipImage) {
  return {
    fileName: entry.image.fileName,
    content: entry.content,
    contentHash: entry.image.contentHash,
    width: entry.image.width,
    height: entry.image.height,
  }
}

async function buildImageAssetMatches(
  batchCode: string,
  zipFile: string,
  referencesByName: Map<string, PatentImageReference[]>,
  imagesByName: Map<string, ReferencedZipImage>,
): Promise<Map<string, ImageAssetMatch>> {
  const patentsByNumber = new Map<string, ParsedPatent>()
  for (const references of referencesByName.values()) {
    for (const reference of references) {
      patentsByNumber.set(reference.patent.patent_number, reference.patent)
    }
  }

  const allPatents = Array.from(patentsByNumber.values())
  const totalPatents = allPatents.length
  const matchLogInterval = 200
  let processed = 0
  let matched = 0

  const matches = new Map<string, ImageAssetMatch>()
  for (const patent of allPatents) {
    if (!patent.abstract_figure) {
      processed++
      continue
    }
    const abstractKey = getImageMapKey(patent.abstract_figure)
    const abstractEntry = imagesByName.get(abstractKey)
    if (!abstractEntry) {
      processed++
      continue
    }

    const drawingEntries = getDrawingImageKeys(patent)
      .filter((imageKey) => imageKey !== abstractKey)
      .map((imageKey) => imagesByName.get(imageKey))
      .filter((entry): entry is ReferencedZipImage => Boolean(entry))

    const match = await matchPatentAbstractToDrawing(
      toMatcherImage(abstractEntry),
      drawingEntries.map(toMatcherImage),
    )
    processed++
    if (match) {
      matched++
      const canonicalImageKey = getImageMapKey(match.drawingFileName)
      matches.set(getPatentImageMatchKey(patent.patent_number, abstractKey), {
        canonicalImageKey,
        displayRotation: match.rotation,
        matchMethod: match.method,
        matchScore: match.score,
        matchedFileName: path.basename(match.drawingFileName),
      })
    }

    if (processed % matchLogInterval === 0 || processed === totalPatents) {
      await addLog(
        batchCode,
        'info',
        `${path.basename(zipFile)}: 附图去重匹配进度 ${processed}/${totalPatents}，已命中重复 ${matched} 个`,
      )
    }
  }

  return matches
}
async function uploadReferencedPatentImages(
  batchCode: string,
  zipFile: string,
  zipIndex: number,
  totalZips: number,
  referencesByName: Map<string, PatentImageReference[]>,
  isCancelled: () => boolean,
): Promise<{
  stats: ImageUploadStats
  processed: number
  skippedEntries: number
}> {
  const concurrency = getImageUploadConcurrency()
  const logInterval = getImageUploadLogInterval()
  const stats: ImageUploadStats = {
    total: Array.from(referencesByName.values()).reduce(
      (sum, refs) => sum + refs.length,
      0,
    ),
    uploaded: 0,
    skipped: 0,
    failed: 0,
  }
  const failures: ImageUploadFailure[] = []
  const active = new Set<Promise<void>>()
  const seenImageKeys = new Set<string>()
  const assetKeyByPatentHash = new Map<string, string>()

  const updateProgress = () => {
    patchProcessProgress(batchCode, {
      phase: 'uploading_images',
      currentZip: path.basename(zipFile),
      processedZips: zipIndex,
      totalZips,
      imageTotal: stats.total,
      imageUploaded: stats.uploaded,
      imageSkipped: stats.skipped,
      imageFailed: stats.failed,
    })
  }

  const waitForSlot = async () => {
    while (active.size >= concurrency) {
      await Promise.race(active)
    }
  }

  const schedule = async (
    reference: PatentImageReference,
    usageEntry: ReferencedZipImage,
    assetEntry: ReferencedZipImage,
    match?: ImageAssetMatch,
  ) => {
    await waitForSlot()
    if (isCancelled()) return

    const task = (async () => {
      const ossKey = buildPatentImageKey(
        batchCode,
        reference.patent.patent_number,
        assetEntry.image.fileName,
      )
      try {
        const result = await attachPatentImage(
          batchCode,
          reference,
          usageEntry.image,
          assetEntry.image,
          assetEntry.content,
          assetKeyByPatentHash,
          match,
        )
        if (result.result === 'skipped') stats.skipped++
        else stats.uploaded++
      } catch (error) {
        stats.failed++
        failures.push({
          fileName: usageEntry.image.fileName,
          patentNumber: reference.patent.patent_number,
          ossKey,
          error: error instanceof Error ? error.message : '未知错误',
        })
      } finally {
        updateProgress()
        const done = stats.uploaded + stats.skipped + stats.failed
        if (done > 0 && done % logInterval === 0) {
          await addLog(
            batchCode,
            'info',
            `${path.basename(zipFile)}: 附图上传进度 ${done}/${stats.total}，上传 ${stats.uploaded}，跳过 ${stats.skipped}，失败 ${stats.failed}`,
          )
        }
      }
    })()
    active.add(task)
    task.finally(() => active.delete(task))
  }

  updateProgress()

  const imagesByName = new Map<string, ReferencedZipImage>()
  const result = await forEachZipEntryBuffer(
    zipFile,
    async (fileName, content) => {
      if (isCancelled()) return
      const imageKey = getImageMapKey(fileName)
      const references = referencesByName.get(imageKey)
      if (!references || !isPatentImageFile(fileName)) return
      if (seenImageKeys.has(imageKey)) return
      seenImageKeys.add(imageKey)

      imagesByName.set(imageKey, {
        image: {
          fileName,
          contentHash: getImageContentHash(content),
          contentType: getImageContentType(fileName),
          size: content.length,
          ...getJpegDimensions(content),
        },
        content,
      })
    },
    (fileName) =>
      isPatentImageFile(fileName) &&
      referencesByName.has(getImageMapKey(fileName)),
  )

  const matchesByPatentImage = await buildImageAssetMatches(
    batchCode,
    zipFile,
    referencesByName,
    imagesByName,
  )

  for (const [imageKey, references] of referencesByName) {
    const usageEntry = imagesByName.get(imageKey)
    if (!usageEntry) continue

    for (const reference of references) {
      const match = matchesByPatentImage.get(
        getPatentImageMatchKey(reference.patent.patent_number, imageKey),
      )
      const assetEntry = match
        ? imagesByName.get(match.canonicalImageKey) || usageEntry
        : usageEntry
      await schedule(reference, usageEntry, assetEntry, match)
    }
  }

  await Promise.all(active)

  if (isCancelled()) {
    throw new Error('Task cancelled')
  }

  if (failures.length > 0) {
    throw new Error(
      `专利附图上传失败: ${JSON.stringify(failures.slice(0, 10))}`,
    )
  }

  for (const references of referencesByName.values()) {
    for (const { patent } of references) {
      if (!patent.images) continue
      patent.images.sort((a, b) => {
        if (a.is_abstract !== b.is_abstract) return a.is_abstract ? -1 : 1
        return a.file_name.localeCompare(b.file_name)
      })
    }
  }

  return {
    stats,
    processed: result.processed,
    skippedEntries: result.skipped,
  }
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

    let innerZips = fs.existsSync(extractDir)
      ? fs
          .readdirSync(extractDir)
          .filter((f) => f.toUpperCase().endsWith('.ZIP'))
          .sort((a, b) => a.localeCompare(b))
      : []

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
          '已解压目录中存在损坏的内层 ZIP，将重新解压',
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
            `解压外层压缩包：${filesToExtract.length} 个文件`,
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
              `合并分卷 ZIP：${group.baseName}（${group.splitParts.length + 1} 个文件）`,
            )
          },
        },
      )

      innerZips = fs
        .readdirSync(extractDir)
        .filter((f) => f.toUpperCase().endsWith('.ZIP'))
        .sort((a, b) => a.localeCompare(b))
    }

    if (cancelled) throw new Error('任务已取消')

    await runExtractedFilesVerification(batchCode, extractDir)

    if (innerZips.length === 0) {
      throw new Error('未找到内层 ZIP 文件')
    }

    await addLog(
      batchCode,
      'info',
      `开始流式解析 ${innerZips.length} 个内层 ZIP`,
    )

    const uploadImages = shouldUploadImagesDuringProcess()
    if (uploadImages && !isOssConfigured()) {
      throw new Error('OSS/MinIO 未配置，无法存储专利附图')
    }
    if (!uploadImages) {
      await addLog(
        batchCode,
        'info',
        '处理步骤已跳过附图上传，仅解析 XML 并生成 parsed.json',
      )
    }

    const patents: ParsedPatent[] = []
    const patentType = batch.data_type as PatentType
    let uploadedImageCount = 0
    let skippedImageCount = 0

    setProcessProgress(batchCode, {
      currentZip: null,
      phase: 'preparing',
      processedZips: 0,
      totalZips: innerZips.length,
      xmlProcessed: 0,
      patentCount: 0,
      imageTotal: 0,
      imageUploaded: 0,
      imageSkipped: 0,
      imageFailed: 0,
    })

    let totalFilteredOut = 0

    for (let i = 0; i < innerZips.length; i++) {
      if (cancelled) throw new Error('任务已取消')

      const zipFile = path.join(extractDir, innerZips[i])
      const zipPatents: ParsedPatent[] = []
      const checkpoint = readProcessZipCheckpoint(
        tempPath,
        zipFile,
        uploadImages,
      )

      if (checkpoint) {
        for (const patent of checkpoint.patents) {
          patents.push(patent)
        }
        uploadedImageCount += checkpoint.uploadedImages
        skippedImageCount += checkpoint.skippedImages
        totalFilteredOut += checkpoint.filteredOut
        updateBatchProgress(batchCode, undefined, i + 1)
        setProcessProgress(batchCode, {
          currentZip: innerZips[i],
          phase: 'preparing',
          processedZips: i + 1,
          totalZips: innerZips.length,
          xmlProcessed: checkpoint.xmlProcessed,
          patentCount: patents.length,
          imageTotal: 0,
          imageUploaded: uploadedImageCount,
          imageSkipped: skippedImageCount,
          imageFailed: 0,
        })
        await addLog(
          batchCode,
          'info',
          `${innerZips[i]}: reused process checkpoint, skipped parsing and image upload`,
        )
        continue
      }

      setProcessProgress(batchCode, {
        currentZip: innerZips[i],
        phase: 'parsing_xml',
        processedZips: i,
        totalZips: innerZips.length,
        xmlProcessed: 0,
        patentCount: patents.length,
        imageTotal: 0,
        imageUploaded: uploadedImageCount,
        imageSkipped: skippedImageCount,
        imageFailed: 0,
      })
      await addLog(batchCode, 'info', `开始处理内层 ZIP：${innerZips[i]}`)
      const xmlResult = await forEachZipEntryBuffer(
        zipFile,
        (fileName, content) => {
          if (cancelled) return
          const patent = parsePatentXml(content.toString('utf-8'), patentType)
          if (patent) {
            patent.source_file = fileName
            zipPatents.push(patent)
          }
        },
        isPatentXmlFile,
      )

      const filterResult = filterPatents(zipPatents)
      totalFilteredOut += filterResult.skipped

      for (const patent of filterResult.filtered) {
        patents.push(patent)
      }

      const referencesByName = new Map<string, PatentImageReference[]>()
      for (const patent of filterResult.filtered) {
        addPatentImageReferences(referencesByName, patent)
      }

      patchProcessProgress(batchCode, {
        xmlProcessed: xmlResult.processed,
        patentCount: patents.length,
        imageTotal: Array.from(referencesByName.values()).reduce(
          (sum, refs) => sum + refs.length,
          0,
        ),
      })

      await addLog(
        batchCode,
        'info',
        `${innerZips[i]}：已解析 ${xmlResult.processed} 个 XML，原始专利 ${zipPatents.length} 条，筛选后 ${filterResult.filtered.length} 条，引用附图文件 ${referencesByName.size} 个`,
      )

      if (cancelled) throw new Error('任务已取消')
      let zipUploadedImageCount = 0
      let zipSkippedImageCount = 0
      if (uploadImages) {
        const imageResult = await uploadReferencedPatentImages(
          batchCode,
          zipFile,
          i,
          innerZips.length,
          referencesByName,
          () => cancelled,
        )
        zipUploadedImageCount = imageResult.stats.uploaded
        zipSkippedImageCount = imageResult.stats.skipped
        uploadedImageCount += zipUploadedImageCount
        skippedImageCount += zipSkippedImageCount

        await addLog(
          batchCode,
          'info',
          `${innerZips[i]}：已解析 ${xmlResult.processed} 个 XML，处理引用附图 ${imageResult.processed} 张，上传 ${imageResult.stats.uploaded} 张，跳过 ${imageResult.stats.skipped} 张，失败 ${imageResult.stats.failed} 张，累计专利 ${patents.length} 条`,
        )
      } else {
        await addLog(
          batchCode,
          'info',
          `${innerZips[i]}：已解析 ${xmlResult.processed} 个 XML，筛选后专利 ${filterResult.filtered.length} 条，已跳过附图上传，累计专利 ${patents.length} 条`,
        )
      }
      preparePatentsForParsedOutput(filterResult.filtered)
      writeProcessZipCheckpoint(tempPath, zipFile, {
        uploadImages,
        xmlProcessed: xmlResult.processed,
        filteredOut: filterResult.skipped,
        uploadedImages: zipUploadedImageCount,
        skippedImages: zipSkippedImageCount,
        patents: filterResult.filtered,
      })
      updateBatchProgress(batchCode, undefined, i + 1)
      patchProcessProgress(batchCode, {
        processedZips: i + 1,
        imageUploaded: uploadedImageCount,
        imageSkipped: skippedImageCount,
      })
    }

    if (patents.length === 0) {
      throw new Error('没有符合筛选条件的专利')
    }

    preparePatentsForParsedOutput(patents)
    const parsedPath = path.join(tempPath, 'parsed.json')
    fs.writeFileSync(parsedPath, JSON.stringify(patents))

    await updateBatchProgress(batchCode, undefined, undefined, patents.length)
    await updateBatchStatus(batchCode, 'processed')
    await addLog(
      batchCode,
      'info',
      `处理完成：${patents.length} 条专利，上传附图 ${uploadedImageCount} 张，跳过附图 ${skippedImageCount} 张，过滤掉 ${totalFilteredOut} 条不符合条件的专利`,
    )

    return {
      success: true,
      batchCode,
      details: {
        totalPatents: patents.length,
        filteredOut: totalFilteredOut,
        innerZips: innerZips.length,
        uploadedImages: uploadedImageCount,
        skippedImages: skippedImageCount,
      },
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误'
    await updateBatchStatus(batchCode, 'failed', errorMessage)
    await addLog(batchCode, 'error', `处理失败：${errorMessage}`)
    return { success: false, batchCode, error: errorMessage }
  } finally {
    runningTasks.delete(batchCode)
    clearProcessProgress(batchCode)
  }
}

export async function runExtractedFilesVerification(
  batchCode: string,
  extractDir: string,
): Promise<void> {
  setProcessProgress(batchCode, {
    phase: 'verifying_crc',
    currentZip: null,
    processedZips: 0,
    totalZips: 0,
    xmlProcessed: 0,
    patentCount: 0,
    imageTotal: 0,
    imageUploaded: 0,
    imageSkipped: 0,
    imageFailed: 0,
  })

  let lastLoggedCount = 0
  const extractCheck = await verifyExtractedFilesCrc(
    extractDir,
    ({ currentFile, checkedCount, totalFiles }) => {
      patchProcessProgress(batchCode, {
        phase: 'verifying_crc',
        currentZip: currentFile,
        processedZips: checkedCount,
        totalZips: totalFiles,
      })
      if (checkedCount - lastLoggedCount >= 1 || checkedCount === totalFiles) {
        lastLoggedCount = checkedCount
        void addLog(
          batchCode,
          'info',
          `CRC 校验进度 ${checkedCount}/${totalFiles}: ${currentFile}`,
        )
      }
    },
  )
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
      'CRC 完整性检测失败:\n' + formatIntegrityReport(extractCheck),
    )
  }
}
