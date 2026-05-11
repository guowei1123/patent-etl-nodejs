import OSS from 'ali-oss'

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
