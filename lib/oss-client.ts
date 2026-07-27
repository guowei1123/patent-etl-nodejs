import OSS from 'ali-oss'
import * as path from 'path'

function isMinioStorage(): boolean {
  return process.env.OBJECT_STORAGE_TYPE === 'minio'
}

export function isOssConfigured(): boolean {
  if (isMinioStorage()) {
    return !!(
      process.env.MINIO_ENDPOINT &&
      process.env.MINIO_ACCESS_KEY &&
      process.env.MINIO_SECRET_KEY &&
      process.env.MINIO_BUCKET_NAME
    )
  }
  return !!(
    process.env.CNIPA_OSS_ACCESS_KEY_ID &&
    process.env.CNIPA_OSS_ACCESS_KEY_SECRET &&
    process.env.CNIPA_OSS_BUCKET_NAME
  )
}

function createOssClient(): OSS {
  return new OSS({
    accessKeyId: process.env.CNIPA_OSS_ACCESS_KEY_ID!,
    accessKeySecret: process.env.CNIPA_OSS_ACCESS_KEY_SECRET!,
    bucket: process.env.CNIPA_OSS_BUCKET_NAME!,
    region: process.env.CNIPA_OSS_REGION || 'cn-shenzhen',
    endpoint: process.env.CNIPA_OSS_ENDPOINT,
  })
}

async function createMinioClient() {
  const { Client } = await import('minio')
  const rawEndpoint = process.env.MINIO_ENDPOINT || 'http://localhost:9000'
  const url = new URL(rawEndpoint.includes('://') ? rawEndpoint : `http://${rawEndpoint}`)
  return new Client({
    endPoint: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 9000)),
    useSSL: url.protocol === 'https:',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  })
}

function getBucketName(): string {
  return isMinioStorage()
    ? process.env.MINIO_BUCKET_NAME || 'patent-images'
    : process.env.CNIPA_OSS_BUCKET_NAME || ''
}

function getImageUploadTimeoutMs(): number {
  const value = parseInt(process.env.IMAGE_UPLOAD_TIMEOUT_MS || '60000', 10)
  return Number.isFinite(value) && value > 0 ? value : 60000
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function buildPatentImageKey(
  batchCode: string,
  docNumber: string,
  fileName: string,
): string {
  const safeBatchCode = batchCode.replace(/[^A-Za-z0-9._-]/g, '_')
  const safeDocNumber = docNumber.replace(/[^A-Za-z0-9._-]/g, '_')
  const safeFileName = path.basename(fileName).replace(/[^A-Za-z0-9._-]/g, '_')
  return `patents/${safeBatchCode}/${safeDocNumber}/${safeFileName}`
}

export async function putPatentImage(
  ossKey: string,
  content: Buffer,
  contentType: string,
): Promise<void> {
  if (!isOssConfigured()) {
    throw new Error('OSS 配置未设置，无法存储专利附图')
  }

  const timeoutMs = getImageUploadTimeoutMs()
  if (isMinioStorage()) {
    const client = await createMinioClient()
    await withTimeout(
      client.putObject(getBucketName(), ossKey, content, content.length, {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=86400',
      }),
      timeoutMs,
      `MinIO 图片上传超时: ${ossKey}`,
    )
    return
  }

  const client = createOssClient()
  await withTimeout(
    client.put(ossKey, content, {
      timeout: timeoutMs,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=86400',
      },
    }),
    timeoutMs,
    `OSS 图片上传超时: ${ossKey}`,
  )
}

export async function patentImageExists(ossKey: string): Promise<boolean> {
  if (!isOssConfigured()) {
    throw new Error('OSS 配置未设置，无法检查专利附图')
  }

  if (isMinioStorage()) {
    const client = await createMinioClient()
    try {
      await client.statObject(getBucketName(), ossKey)
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'NotFound') {
        return false
      }
      throw error
    }
  }

  const client = createOssClient()
  try {
    await client.head(ossKey, { timeout: getImageUploadTimeoutMs() })
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error &&
      (error as { status?: number }).status === 404
    ) {
      return false
    }
    throw error
  }
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

export async function getPatentImage(ossKey: string): Promise<{
  content: Buffer
  contentType: string
}> {
  if (!isOssConfigured()) {
    throw new Error('OSS 配置未设置，无法读取专利附图')
  }

  if (isMinioStorage()) {
    const client = await createMinioClient()
    const [stat, stream] = await Promise.all([
      client.statObject(getBucketName(), ossKey),
      client.getObject(getBucketName(), ossKey),
    ])
    return {
      content: await streamToBuffer(stream),
      contentType: String(stat.metaData?.['content-type'] || stat.metaData?.['Content-Type'] || 'image/jpeg'),
    }
  }

  const client = createOssClient()
  const result = await client.get(ossKey)
  const rawContentType = result.res?.headers?.['content-type']
  const contentType = Array.isArray(rawContentType)
    ? rawContentType[0]
    : rawContentType
  return {
    content: result.content,
    contentType: contentType || 'image/jpeg',
  }
}

export async function testOssConnection(): Promise<{
  success: boolean
  error?: string
}> {
  try {
    if (isMinioStorage()) {
      const client = await createMinioClient()
      await client.bucketExists(getBucketName())
    } else {
      const client = createOssClient()
      await client.list({ 'max-keys': 1 })
    }
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}
