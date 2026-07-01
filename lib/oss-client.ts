import OSS from 'ali-oss'
import * as path from 'path'

export function isOssConfigured(): boolean {
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

  const client = createOssClient()
  const timeoutMs = getImageUploadTimeoutMs()
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

export async function getPatentImage(ossKey: string): Promise<{
  content: Buffer
  contentType: string
}> {
  if (!isOssConfigured()) {
    throw new Error('OSS 配置未设置，无法读取专利附图')
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
    const client = createOssClient()
    await client.list({ 'max-keys': 1 })
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}
