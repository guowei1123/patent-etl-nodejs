import { NextResponse } from 'next/server'
import { isDbConfigured } from '@/lib/db'
import { isFtpConfigured } from '@/lib/ftp-client'
import { isOssConfigured } from '@/lib/oss-client'
import { isRedisClassificationsConfigured } from '@/lib/redis-classifications'
import { isEmbeddingConfigured } from '@/lib/embedding'

function parseDataPaths(): { invention: string; utility_model: string } {
  const raw = process.env.CNIPA_FTP_DATA_PATHS || ''
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  return {
    invention: parts[0] || '',
    utility_model: parts[1] || '',
  }
}

function parseRedisUrl(): { host: string; port: string; db: string } {
  const url = process.env.REDIS_URL || ''
  if (!url) return { host: '', port: '', db: '' }
  try {
    const parsed = new URL(url)
    return {
      host: parsed.hostname,
      port: parsed.port || '6379',
      db: parsed.pathname && parsed.pathname.length > 1 ? parsed.pathname.slice(1) : '0',
    }
  } catch {
    return { host: '', port: '', db: '' }
  }
}

export async function GET() {
  const redis = parseRedisUrl()
  return NextResponse.json({
    ftp: {
      configured: isFtpConfigured(),
      host: process.env.CNIPA_FTP_HOST || process.env.FTP_HOST || '',
      port: process.env.CNIPA_FTP_PORT || process.env.FTP_PORT || '21',
      user: process.env.CNIPA_FTP_USER || process.env.FTP_USER || '',
      data_paths: parseDataPaths(),
    },
    oss: {
      configured: isOssConfigured(),
      bucket: process.env.MINIO_BUCKET_NAME || process.env.CNIPA_OSS_BUCKET_NAME || '',
      region: process.env.MINIO_REGION || process.env.CNIPA_OSS_REGION || '',
      endpoint: process.env.MINIO_ENDPOINT || process.env.CNIPA_OSS_ENDPOINT || '',
    },
    database: {
      configured: isDbConfigured(),
      type: process.env.DATABASE_TYPE || 'postgres',
      host:
        process.env.DATABASE_TYPE === 'sqlite'
          ? 'local'
          : process.env.CNIPA_PG_HOST || '',
      port:
        process.env.DATABASE_TYPE === 'sqlite'
          ? ''
          : process.env.CNIPA_PG_PORT || '5432',
      db:
        process.env.DATABASE_TYPE === 'sqlite'
          ? process.env.DATABASE_PATH || './data/patent-etl.sqlite'
          : process.env.CNIPA_PG_DB || '',
      user:
        process.env.DATABASE_TYPE === 'sqlite'
          ? ''
          : process.env.CNIPA_PG_USER || '',
    },
    redis: {
      configured: isRedisClassificationsConfigured(),
      host: redis.host,
      port: redis.port,
      db: redis.db,
    },
    embedding: {
      configured: isEmbeddingConfigured(),
      model: process.env.OPENAI_EMBEDDING_MODEL || '',
    },
  })
}

