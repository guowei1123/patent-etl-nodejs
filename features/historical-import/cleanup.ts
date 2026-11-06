import pg from 'pg'
import OSS from 'ali-oss'
import { minioEndpointForKey } from '../../lib/oss-client.ts'

function pool() {
  return new pg.Pool(
    process.env.DATABASE_URL
      ? {
          connectionString: process.env.DATABASE_URL,
          connectionTimeoutMillis: 10000,
        }
      : {
          host: process.env.CNIPA_PG_HOST,
          port: Number(process.env.CNIPA_PG_PORT || 5432),
          database: process.env.CNIPA_PG_DB,
          user: process.env.CNIPA_PG_USER,
          password: process.env.CNIPA_PG_PASSWORD,
          connectionTimeoutMillis: 10000,
        },
  )
}
export async function cleanupCandidates(jobId: string) {
  const db = pool()
  try {
    const table = await db.query(
      "SELECT to_regclass('cnipa.history_image_cleanup') AS name",
    )
    if (!table.rows[0].name) return [] as string[]
    const result = await db.query<{ oss_key: string }>(
      `SELECT c.oss_key FROM cnipa.history_image_cleanup c WHERE c.job_id=$1 AND c.status='pending'
      AND NOT EXISTS(SELECT 1 FROM cnipa.patent_image i LEFT JOIN cnipa.image_asset a ON a.id=i.asset_id WHERE COALESCE(a.oss_key,i.oss_key)=c.oss_key)
      ORDER BY c.oss_key LIMIT 100`,
      [jobId],
    )
    return result.rows.map((row) => row.oss_key)
  } finally {
    await db.end()
  }
}
async function removeObject(key: string) {
  if (process.env.OBJECT_STORAGE_TYPE === 'minio') {
    const { Client } = await import('minio')
    const endpoint = minioEndpointForKey(key)
    const url = new URL(
      endpoint.includes('://') ? endpoint : `http://${endpoint}`,
    )
    const client = new Client({
      endPoint: url.hostname,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 9000)),
      useSSL: url.protocol === 'https:',
      accessKey: process.env.MINIO_ACCESS_KEY!,
      secretKey: process.env.MINIO_SECRET_KEY!,
    })
    await client.removeObject(process.env.MINIO_BUCKET_NAME!, key)
  } else {
    const options = {
      accessKeyId: process.env.CNIPA_OSS_ACCESS_KEY_ID!,
      accessKeySecret: process.env.CNIPA_OSS_ACCESS_KEY_SECRET!,
      bucket: process.env.CNIPA_OSS_BUCKET_NAME!,
      region: process.env.CNIPA_OSS_REGION || 'cn-shenzhen',
      endpoint: process.env.CNIPA_OSS_ENDPOINT,
      timeout: 15000,
    }
    // The repository's minimal ali-oss declaration omits the SDK's delete API.
    const client = new OSS(options) as unknown as {
      delete(name: string): Promise<unknown>
    }
    await client.delete(key)
  }
}
export async function cleanupObjects(jobId: string, approved: string[]) {
  const current = new Set(await cleanupCandidates(jobId))
  if (
    !approved.length ||
    approved.some((key) => !current.has(key) || !key.startsWith('patents/'))
  )
    throw new Error('清理清单已变化，请重新预览')
  const db = pool()
  let removed = 0
  try {
    for (const key of approved) {
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          'SELECT id FROM cnipa.image_asset WHERE oss_key=$1 FOR UPDATE',
          [key],
        )
        const referenced = await client.query(
          `SELECT i.id FROM cnipa.patent_image i LEFT JOIN cnipa.image_asset a ON a.id=i.asset_id WHERE COALESCE(a.oss_key,i.oss_key)=$1 LIMIT 1`,
          [key],
        )
        if (!referenced.rowCount) {
          await removeObject(key)
          await client.query('DELETE FROM cnipa.image_asset WHERE oss_key=$1', [
            key,
          ])
          await client.query(
            "UPDATE cnipa.history_image_cleanup SET status='removed' WHERE oss_key=$1",
            [key],
          )
          removed++
        }
        await client.query('COMMIT')
      } catch {
        await client.query('ROLLBACK')
        throw new Error('对象清理未完成，请检查存储连接后重新预览')
      } finally {
        client.release()
      }
    }
    return removed
  } finally {
    await db.end()
  }
}
