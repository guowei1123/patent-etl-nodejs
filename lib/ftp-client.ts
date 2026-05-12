import * as ftp from 'basic-ftp'
import * as fs from 'fs'
import * as path from 'path'
import type { FtpConfig, FtpEntry } from '@/types'

export interface DownloadFileResult {
  skipped: boolean
  resumed: boolean
}

export class FtpClient {
  private client: ftp.Client
  private config: FtpConfig
  private connected: boolean = false

  constructor(config?: Partial<FtpConfig>) {
    const timeout =
      config?.timeout || parseInt(process.env.FTP_TIMEOUT || '120000')
    this.client = new ftp.Client(timeout)
    this.client.ftp.verbose = process.env.NODE_ENV === 'development'

    this.config = {
      host:
        config?.host ||
        process.env.CNIPA_FTP_HOST ||
        process.env.FTP_HOST ||
        '',
      port:
        config?.port ||
        parseInt(process.env.CNIPA_FTP_PORT || process.env.FTP_PORT || '21'),
      user:
        config?.user ||
        process.env.CNIPA_FTP_USER ||
        process.env.FTP_USER ||
        '',
      password:
        config?.password ||
        process.env.CNIPA_FTP_PASSWORD ||
        process.env.FTP_PASSWORD ||
        '',
      secure:
        config?.secure ??
        (process.env.CNIPA_FTP_SECURE === 'true' ||
          process.env.FTP_SECURE === 'true'),
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return

    try {
      await this.client.access({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        secure: this.config.secure,
        secureOptions: { rejectUnauthorized: false },
      })
      this.connected = true
    } catch (error) {
      throw new Error(
        `FTP连接失败: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      this.client.close()
      this.connected = false
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.connect()
      await this.client.pwd()
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    } finally {
      await this.disconnect()
    }
  }

  async listDirectory(remotePath: string = '/'): Promise<FtpEntry[]> {
    await this.connect()

    try {
      const list = await this.client.list(remotePath)
      return list.map((item) => ({
        name: item.name,
        type: item.isDirectory ? 'directory' : 'file',
        size: item.size,
        modifiedAt: item.modifiedAt || null,
        path: path.posix.join(remotePath, item.name),
      }))
    } catch (error) {
      throw new Error(
        `列出目录失败 ${remotePath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  async downloadFile(
    remotePath: string,
    localPath: string,
    options?: {
      onProgress?: (bytes: number, total: number) => void
      resume?: boolean
      remoteSize?: number
    },
  ): Promise<DownloadFileResult> {
    await this.connect()

    // 确保本地目录存在
    const localDir = path.dirname(localPath)
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true })
    }

    const onProgress = options?.onProgress
    const resume = options?.resume ?? false

    try {
      // 使用传入的 remoteSize 或额外获取
      const remoteSize =
        options?.remoteSize ??
        (await this.client.size(remotePath).catch(() => 0))

      // 断点续传：检查本地文件
      if (resume && remoteSize > 0) {
        let localSize = 0
        try {
          if (fs.existsSync(localPath)) {
            localSize = fs.statSync(localPath).size
          }
        } catch {
          localSize = 0
        }

        // 文件已完整下载，跳过
        if (localSize === remoteSize) {
          return { skipped: true, resumed: false }
        }

        // 部分文件存在，从断点续传
        if (localSize > 0 && localSize < remoteSize) {
          if (onProgress) {
            this.client.trackProgress((info) => {
              onProgress(localSize + info.bytesOverall, remoteSize)
            })
          }

          await this.client.downloadTo(localPath, remotePath, localSize)
          this.client.trackProgress()
          return { skipped: false, resumed: true }
        }

        // 本地文件比远程大或为 0，删除重新下载
        if (localSize > remoteSize) {
          fs.unlinkSync(localPath)
        }
      }

      // 全新下载
      if (onProgress && remoteSize > 0) {
        this.client.trackProgress((info) => {
          onProgress(info.bytesOverall, remoteSize)
        })
      }

      await this.client.downloadTo(localPath, remotePath)
      this.client.trackProgress()

      return { skipped: false, resumed: false }
    } catch (error) {
      // 非续传模式下，清理部分下载的文件
      if (!resume && fs.existsSync(localPath)) {
        fs.unlinkSync(localPath)
      }
      throw new Error(
        `下载文件失败 ${remotePath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  async downloadDirectory(
    remotePath: string,
    localPath: string,
    options?: {
      filter?: (entry: FtpEntry) => boolean
      onFileDownloaded?: (
        fileName: string,
        index: number,
        total: number,
      ) => void
      onFileProgress?: (fileName: string, bytes: number, total: number) => void
      resume?: boolean
      preFetchedEntries?: FtpEntry[]
    },
  ): Promise<string[]> {
    await this.connect()

    const filter = options?.filter
    const onFileDownloaded = options?.onFileDownloaded
    const onFileProgress = options?.onFileProgress
    const resume = options?.resume ?? false

    const downloadedFiles: string[] = []

    // 确保本地目录存在
    if (!fs.existsSync(localPath)) {
      fs.mkdirSync(localPath, { recursive: true })
    }

    const entries =
      options?.preFetchedEntries ?? (await this.listDirectory(remotePath))
    const filesToDownload =
      filter && !options?.preFetchedEntries
        ? entries.filter((e) => e.type === 'file' && filter(e))
        : entries.filter((e) => e.type === 'file')

    for (let i = 0; i < filesToDownload.length; i++) {
      const entry = filesToDownload[i]
      const localFilePath = path.join(localPath, entry.name)

      const result = await this.downloadFile(entry.path, localFilePath, {
        onProgress: onFileProgress
          ? (bytes, total) => onFileProgress(entry.name, bytes, total)
          : undefined,
        resume,
        remoteSize: entry.size,
      })

      if (!result.skipped) {
        downloadedFiles.push(localFilePath)
      }

      if (onFileDownloaded) {
        onFileDownloaded(entry.name, i + 1, filesToDownload.length)
      }
    }

    return downloadedFiles
  }

  // 查找符合模式的文件夹（用于查找特定周的数据）
  async findFolders(basePath: string, pattern: RegExp): Promise<FtpEntry[]> {
    await this.connect()

    const entries = await this.listDirectory(basePath)
    return entries.filter((e) => e.type === 'directory' && pattern.test(e.name))
  }

  // 获取专利数据文件夹列表
  // CNIPA FTP 通常有如下结构:
  // /发明授权/2024/202401/ 或类似
  async getPatentDataFolders(
    dataType: 'invention' | 'utility_model',
  ): Promise<FtpEntry[]> {
    await this.connect()

    // 根据数据类型确定基础路径
    const basePath = dataType === 'invention' ? '/发明授权' : '/实用新型授权'

    try {
      const years = await this.listDirectory(basePath)
      const folders: FtpEntry[] = []

      for (const year of years.filter((y) => y.type === 'directory')) {
        const weekFolders = await this.listDirectory(year.path)
        folders.push(...weekFolders.filter((f) => f.type === 'directory'))
      }

      return folders.sort((a, b) => b.name.localeCompare(a.name))
    } catch {
      // 如果路径不存在，返回根目录内容供用户选择
      return this.listDirectory('/')
    }
  }

  isConnected(): boolean {
    return this.connected
  }
}

// 单例实例用于简单场景
let defaultClient: FtpClient | null = null

export function getDefaultFtpClient(): FtpClient {
  if (!defaultClient) {
    defaultClient = new FtpClient()
  }
  return defaultClient
}

export function isFtpConfigured(): boolean {
  return (
    !!(process.env.CNIPA_FTP_HOST || process.env.FTP_HOST) &&
    !!(process.env.CNIPA_FTP_USER || process.env.FTP_USER)
  )
}

export function createFtpClient(config?: Partial<FtpConfig>): FtpClient {
  return new FtpClient(config)
}

// ============ 并行下载连接池 ============

export interface PoolDownloadOptions {
  onFileDownloaded?: (
    fileName: string,
    index: number,
    total: number,
    skipped: boolean,
  ) => void
  onFileProgress?: (fileName: string, bytes: number, total: number) => void
  resume?: boolean
  cancelled?: () => boolean
}

export class FtpConnectionPool {
  private config: FtpConfig
  private concurrency: number
  private clients: ftp.Client[] = []

  constructor(config?: Partial<FtpConfig>, concurrency?: number) {
    this.concurrency =
      concurrency || parseInt(process.env.FTP_CONCURRENCY || '3')

    const timeout =
      config?.timeout || parseInt(process.env.FTP_TIMEOUT || '120000')
    this.config = {
      host:
        config?.host ||
        process.env.CNIPA_FTP_HOST ||
        process.env.FTP_HOST ||
        '',
      port:
        config?.port ||
        parseInt(process.env.CNIPA_FTP_PORT || process.env.FTP_PORT || '21'),
      user:
        config?.user ||
        process.env.CNIPA_FTP_USER ||
        process.env.FTP_USER ||
        '',
      password:
        config?.password ||
        process.env.CNIPA_FTP_PASSWORD ||
        process.env.FTP_PASSWORD ||
        '',
      secure:
        config?.secure ??
        (process.env.CNIPA_FTP_SECURE === 'true' ||
          process.env.FTP_SECURE === 'true'),
      timeout,
    }

    this.clients = Array.from({ length: this.concurrency }, () => {
      const client = new ftp.Client(timeout)
      client.ftp.verbose = process.env.NODE_ENV === 'development'
      return client
    })
  }

  async connect(): Promise<void> {
    await Promise.all(
      this.clients.map(async (client) => {
        await client.access({
          host: this.config.host,
          port: this.config.port,
          user: this.config.user,
          password: this.config.password,
          secure: this.config.secure,
          secureOptions: { rejectUnauthorized: false },
        })
      }),
    )
  }

  disconnect(): void {
    for (const client of this.clients) {
      try {
        client.close()
      } catch {}
    }
  }

  async downloadFiles(
    entries: FtpEntry[],
    localDir: string,
    options?: PoolDownloadOptions,
  ): Promise<{
    downloadedPaths: string[]
    totalProcessed: number
    skippedCount: number
  }> {
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true })
    }

    const total = entries.length
    const results: Array<{
      entry: FtpEntry
      localPath: string
      skipped: boolean
    }> = []
    let nextIndex = 0
    let completedCount = 0

    const isCancelled = options?.cancelled ?? (() => false)

    const worker = async (client: ftp.Client) => {
      while (true) {
        if (isCancelled()) return

        const idx = nextIndex++
        if (idx >= total) return

        const entry = entries[idx]
        const localPath = path.join(localDir, entry.name)

        // 确保本地目录存在
        const localFileDir = path.dirname(localPath)
        if (!fs.existsSync(localFileDir)) {
          fs.mkdirSync(localFileDir, { recursive: true })
        }

        const remoteSize = entry.size
        const resume = options?.resume ?? false

        try {
          // 断点续传：检查本地文件
          if (resume && remoteSize > 0) {
            let localSize = 0
            try {
              if (fs.existsSync(localPath)) {
                localSize = fs.statSync(localPath).size
              }
            } catch {
              localSize = 0
            }

            // 文件已完整下载，跳过
            if (localSize === remoteSize) {
              results.push({ entry, localPath, skipped: true })
              completedCount++
              options?.onFileDownloaded?.(
                entry.name,
                completedCount,
                total,
                true,
              )
              continue
            }

            // 部分文件存在，从断点续传
            if (localSize > 0 && localSize < remoteSize) {
              if (options?.onFileProgress) {
                client.trackProgress((info) => {
                  options.onFileProgress!(
                    entry.name,
                    localSize + info.bytesOverall,
                    remoteSize,
                  )
                })
              }
              await client.downloadTo(localPath, entry.path, localSize)
              client.trackProgress()
              results.push({ entry, localPath, skipped: false })
              completedCount++
              options?.onFileDownloaded?.(
                entry.name,
                completedCount,
                total,
                false,
              )
              continue
            }

            // 本地文件比远程大，删除重新下载
            if (localSize > remoteSize) {
              fs.unlinkSync(localPath)
            }
          }

          // 全新下载
          if (options?.onFileProgress && remoteSize > 0) {
            client.trackProgress((info) => {
              options.onFileProgress!(entry.name, info.bytesOverall, remoteSize)
            })
          }

          await client.downloadTo(localPath, entry.path)
          client.trackProgress()

          results.push({ entry, localPath, skipped: false })
          completedCount++
          options?.onFileDownloaded?.(entry.name, completedCount, total, false)
        } catch (error) {
          if (!resume && fs.existsSync(localPath)) {
            fs.unlinkSync(localPath)
          }
          throw new Error(
            `下载文件失败 ${entry.path}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          )
        }
      }
    }

    await Promise.all(this.clients.map(worker))

    return {
      downloadedPaths: results
        .filter((r) => !r.skipped)
        .map((r) => r.localPath),
      totalProcessed: results.length,
      skippedCount: results.filter((r) => r.skipped).length,
    }
  }
}

export function createFtpPool(
  config?: Partial<FtpConfig>,
  concurrency?: number,
): FtpConnectionPool {
  return new FtpConnectionPool(config, concurrency)
}
