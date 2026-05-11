import { NextResponse } from 'next/server'
import { isDbConfigured } from '@/lib/db'
import { isFtpConfigured } from '@/lib/ftp-client'
import { isOssConfigured } from '@/lib/oss-client'

export async function GET() {
  return NextResponse.json({
    ftp: {
      configured: isFtpConfigured(),
      host: process.env.CNIPA_FTP_HOST || process.env.FTP_HOST || '',
      port: process.env.CNIPA_FTP_PORT || process.env.FTP_PORT || '21',
      user: process.env.CNIPA_FTP_USER || process.env.FTP_USER || '',
    },
    oss: {
      configured: isOssConfigured(),
      bucket: process.env.CNIPA_OSS_BUCKET_NAME || '',
      region: process.env.CNIPA_OSS_REGION || '',
      endpoint: process.env.CNIPA_OSS_ENDPOINT || '',
    },
    database: {
      configured: isDbConfigured(),
      host: process.env.CNIPA_PG_HOST || '',
      port: process.env.CNIPA_PG_PORT || '5432',
      db: process.env.CNIPA_PG_DB || '',
      user: process.env.CNIPA_PG_USER || '',
    },
  })
}
