/** Start the historical-image MinIO instance without interrupting the original instance. */
import { spawn } from 'node:child_process'
import { open, mkdir, realpath, access } from 'node:fs/promises'
import path from 'node:path'

const executable = process.env.MINIO_HISTORY_EXECUTABLE || 'D:\\minio\\minio.exe'
const directory = process.env.MINIO_HISTORY_DATA_DIR || 'F:\\patent-data\\minio-store'
const endpoint = new URL(process.env.MINIO_HISTORY_ENDPOINT || 'http://localhost:9002')
const consolePort = Number(process.env.MINIO_HISTORY_CONSOLE_PORT || 9003)
await access(executable)
const dataRoot = await realpath(directory)
if (!process.env.MINIO_ACCESS_KEY || !process.env.MINIO_SECRET_KEY)
  throw new Error('请在 .env 配置 MinIO 凭据')
try {
  const health = await fetch(new URL('/minio/health/live', endpoint), { signal: AbortSignal.timeout(2000) })
  if (health.ok) throw new Error('历史 MinIO 端口已有服务，请核对存储路径，勿重复启动')
} catch (error) {
  if (error instanceof Error && error.message.includes('端口已有')) throw error
}
const logRoot = path.resolve('outputs/history-minio-service')
await mkdir(logRoot, { recursive: true })
const log = await open(path.join(logRoot, 'minio.log'), 'a')
try {
  const child = spawn(executable, ['server', dataRoot, '--address', `127.0.0.1:${endpoint.port || 9002}`, '--console-address', `127.0.0.1:${consolePort}`], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, MINIO_ROOT_USER: process.env.MINIO_ACCESS_KEY, MINIO_ROOT_PASSWORD: process.env.MINIO_SECRET_KEY },
  })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  child.unref()
  console.log(JSON.stringify({ pid: child.pid, dataRoot, endpoint: endpoint.origin, consolePort }))
} finally {
  await log.close()
}
