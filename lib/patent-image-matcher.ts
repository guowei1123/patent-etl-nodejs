type SharpRawResult = {
  data: Buffer
  info: { width: number; height: number }
}

type SharpPipeline = {
  rotate(angle?: number): SharpPipeline
  grayscale(): SharpPipeline
  raw(): SharpPipeline
  resize(width: number, height: number, options?: unknown): SharpPipeline
  toBuffer(options: { resolveWithObject: true }): Promise<SharpRawResult>
}

type SharpFactory = (input?: unknown, options?: unknown) => SharpPipeline

let sharpFactoryPromise: Promise<SharpFactory> | null = null

async function loadSharp(): Promise<SharpFactory> {
  sharpFactoryPromise ||= (async () => {
    const importer = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<{ default?: SharpFactory } & SharpFactory>
    const mod = await importer('sharp')
    return mod.default || (mod as SharpFactory)
  })()
  return sharpFactoryPromise
}

type ImageInput = {
  fileName: string
  content: Buffer
  contentHash: string
  width?: number
  height?: number
}

export type PatentImageMatch = {
  abstractFileName: string
  drawingFileName: string
  rotation: number
  method: 'sha256' | 'hash-top5-binary-structure'
  score: number
}

type Crop = {
  data: Buffer
  width: number
  height: number
}

type HashFeature = {
  rotation: number
  crop: Crop
  dhash: number[]
  phash: number[]
}

type BinaryFeature = HashFeature & {
  binary: Buffer
}

type HashCandidate = {
  image: ImageInput
  feature: HashFeature
  hashScore: number
  dhashDistance: number
  phashDistance: number
}

const WHITE_THRESHOLD = 245
const PHASH_SIZE = 16
const BINARY_SIZE = 128
const ROTATIONS = [0, 90, 180, 270] as const
const DEFAULT_MATCH_THRESHOLD = 0.75
const HASH_PREFILTER_LIMIT = 5

function imageKey(fileName: string): string {
  const normalized = fileName.split('\\').join('/')
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
}

function hamming(a: number[], b: number[]): number {
  let distance = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) distance++
  }
  return distance + Math.abs(a.length - b.length)
}

async function grayCrop(content: Buffer, rotation: number): Promise<Crop> {
  const { data, info } = await (await loadSharp())(content)
    .rotate()
    .rotate(rotation)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const width = info.width
  const height = info.height
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0, index = 0; y < height; y++) {
    for (let x = 0; x < width; x++, index++) {
      if (data[index] < WHITE_THRESHOLD) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < 0) return { data, width, height }

  const pad = 2
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(width - 1, maxX + pad)
  maxY = Math.min(height - 1, maxY + pad)

  const cropWidth = maxX - minX + 1
  const cropHeight = maxY - minY + 1
  const cropped = Buffer.alloc(cropWidth * cropHeight)
  for (let y = 0; y < cropHeight; y++) {
    data.copy(
      cropped,
      y * cropWidth,
      (minY + y) * width + minX,
      (minY + y) * width + minX + cropWidth,
    )
  }

  return { data: cropped, width: cropWidth, height: cropHeight }
}

async function resizeGray(
  crop: Crop,
  width: number,
  height: number,
): Promise<Buffer> {
  const { data } = await (await loadSharp())(crop.data, {
    raw: { width: crop.width, height: crop.height, channels: 1 },
  })
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  return data
}

async function dhash(crop: Crop): Promise<number[]> {
  const data = await resizeGray(crop, 17, 16)
  const bits: number[] = []
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      bits.push(data[y * 17 + x] > data[y * 17 + x + 1] ? 1 : 0)
    }
  }
  return bits
}

const cosCache = Array.from({ length: PHASH_SIZE }, (_, u) =>
  Array.from({ length: PHASH_SIZE }, (_, x) =>
    Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PHASH_SIZE)),
  ),
)

function dctTop8(values: number[]): number[] {
  const out: number[] = []
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0
      for (let y = 0; y < PHASH_SIZE; y++) {
        for (let x = 0; x < PHASH_SIZE; x++) {
          sum += values[y * PHASH_SIZE + x] * cosCache[u][x] * cosCache[v][y]
        }
      }
      out.push(sum)
    }
  }
  return out
}

async function phash(crop: Crop): Promise<number[]> {
  const data = await resizeGray(crop, PHASH_SIZE, PHASH_SIZE)
  const coeff = dctTop8([...data]).slice(1)
  const sorted = [...coeff].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  return coeff.map((value) => (value > median ? 1 : 0))
}

function otsu(data: Buffer): number {
  const hist = new Array<number>(256).fill(0)
  for (const value of data) hist[value]++

  const total = data.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]

  let sumB = 0
  let weightB = 0
  let best = 0
  let max = 0
  for (let threshold = 0; threshold < 256; threshold++) {
    weightB += hist[threshold]
    if (weightB === 0) continue
    const weightF = total - weightB
    if (weightF === 0) break
    sumB += threshold * hist[threshold]
    const meanB = sumB / weightB
    const meanF = (sum - sumB) / weightF
    const between = weightB * weightF * (meanB - meanF) ** 2
    if (between > max) {
      max = between
      best = threshold
    }
  }
  return best
}

async function binary(crop: Crop): Promise<Buffer> {
  const data = await resizeGray(crop, BINARY_SIZE, BINARY_SIZE)
  const threshold = otsu(data)
  return Buffer.from([...data].map((value) => (value > threshold ? 255 : 0)))
}

function pixelAgreement(a: Buffer, b: Buffer): number {
  let same = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) same++
  }
  return same / a.length
}

function globalSsim(a: Buffer, b: Buffer): number {
  const n = a.length
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < n; i++) {
    meanA += a[i]
    meanB += b[i]
  }
  meanA /= n
  meanB /= n

  let varA = 0
  let varB = 0
  let cov = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    varA += da * da
    varB += db * db
    cov += da * db
  }
  varA /= n - 1
  varB /= n - 1
  cov /= n - 1

  const c1 = 6.5025
  const c2 = 58.5225
  return ((2 * meanA * meanB + c1) * (2 * cov + c2)) /
    ((meanA ** 2 + meanB ** 2 + c1) * (varA + varB + c2))
}

async function hashFeature(
  image: ImageInput,
  rotation: number,
): Promise<HashFeature> {
  const crop = await grayCrop(image.content, rotation)
  const [dhashValue, phashValue] = await Promise.all([dhash(crop), phash(crop)])
  return {
    rotation,
    crop,
    dhash: dhashValue,
    phash: phashValue,
  }
}

async function binaryFeature(feature: HashFeature): Promise<BinaryFeature> {
  return {
    ...feature,
    binary: await binary(feature.crop),
  }
}

function hashScorePair(
  abstractFeature: HashFeature,
  drawingFeature: HashFeature,
): { hashScore: number; dhashDistance: number; phashDistance: number } {
  const dhashDistance = hamming(abstractFeature.dhash, drawingFeature.dhash)
  const phashDistance = hamming(abstractFeature.phash, drawingFeature.phash)
  return {
    hashScore: 1 - (dhashDistance / 256 + phashDistance / 63) / 2,
    dhashDistance,
    phashDistance,
  }
}

function structureScorePair(
  abstractFeature: BinaryFeature,
  drawingFeature: BinaryFeature,
  hashScore: number,
): number {
  const pixelScore = pixelAgreement(abstractFeature.binary, drawingFeature.binary)
  const ssimScore = globalSsim(abstractFeature.binary, drawingFeature.binary)
  return 0.2 * hashScore + 0.5 * pixelScore + 0.3 * ssimScore
}

async function hashTopCandidates(
  abstractFeature: HashFeature,
  drawingImages: ImageInput[],
): Promise<HashCandidate[]> {
  const candidates: HashCandidate[] = []
  for (const image of drawingImages) {
    for (const rotation of ROTATIONS) {
      const feature = await hashFeature(image, rotation)
      const scores = hashScorePair(abstractFeature, feature)
      candidates.push({
        image,
        feature,
        ...scores,
      })
    }
  }

  return candidates
    .sort((a, b) => b.hashScore - a.hashScore)
    .slice(0, HASH_PREFILTER_LIMIT)
}

async function bestVisualMatch(
  abstractImage: ImageInput,
  drawingImages: ImageInput[],
): Promise<PatentImageMatch | null> {
  const abstractHashFeature = await hashFeature(abstractImage, 0)
  const topCandidates = await hashTopCandidates(abstractHashFeature, drawingImages)
  if (topCandidates.length === 0) return null

  const abstractFeature = await binaryFeature(abstractHashFeature)
  let best: PatentImageMatch | null = null

  for (const candidate of topCandidates) {
    const drawingFeature = await binaryFeature(candidate.feature)
    const score = structureScorePair(
      abstractFeature,
      drawingFeature,
      candidate.hashScore,
    )
    if (!best || score > best.score) {
      best = {
        abstractFileName: abstractImage.fileName,
        drawingFileName: candidate.image.fileName,
        rotation: candidate.feature.rotation,
        method: 'hash-top5-binary-structure',
        score,
      }
    }
  }

  return best && best.score >= DEFAULT_MATCH_THRESHOLD ? best : null
}

export async function matchPatentAbstractToDrawing(
  abstractImage: ImageInput | undefined,
  drawingImages: ImageInput[],
): Promise<PatentImageMatch | null> {
  if (!abstractImage || drawingImages.length === 0) return null

  const exact = drawingImages.find(
    (drawing) => drawing.contentHash === abstractImage.contentHash,
  )
  if (exact) {
    return {
      abstractFileName: abstractImage.fileName,
      drawingFileName: exact.fileName,
      rotation: 0,
      method: 'sha256',
      score: 1,
    }
  }

  try {
    return await bestVisualMatch(abstractImage, drawingImages)
  } catch {
    return null
  }
}

export function buildImageKey(fileName: string): string {
  return imageKey(fileName)
}
