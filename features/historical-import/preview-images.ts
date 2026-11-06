import path from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { getJob, jobDirectory } from './jobs'
import {
  validateManifest,
  readVerifiedImage,
  type PdfManifest,
} from './pdf/historical-pdf'
import { imageAssetPlan } from './images'

export async function previewImages(
  id: string,
  publication: string,
  file?: string | null,
) {
  const job = await getJob(id)
  const record = job.sample.find((item) => item.publication === publication)
  if (!record?.pdfManifest) throw new Error('本候选没有可预览附图')
  const root = await realpath(jobDirectory(id))
  const manifestFile = await realpath(record.pdfManifest)
  const relative = path.relative(root, manifestFile)
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('附图路径无效')
  const manifest: PdfManifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  validateManifest(manifest, 'HISTORY')
  if (manifest.patent_number !== publication)
    throw new Error('附图公开号不一致')
  if (file) {
    const image = manifest.images.find((item) => item.file_name === file)
    if (!image) throw new Error('附图文件无效')
    return {
      content: await readVerifiedImage(path.dirname(manifestFile), image),
    }
  }
  const contents = await Promise.all(
    manifest.images.map((image) =>
      readVerifiedImage(path.dirname(manifestFile), image),
    ),
  )
  const plan = await imageAssetPlan(manifest, contents)
  return {
    data: {
      publication,
      uniqueImages: new Set(plan.map((item) => item.canonical)).size,
      images: plan.map((item) => ({
        ...item.image,
        canonical: manifest.images[item.canonical].file_name,
        rotation: item.rotation,
        matchMethod: item.method,
      })),
    },
  }
}
