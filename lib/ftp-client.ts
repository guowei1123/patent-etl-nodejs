import * as ftp from 'basic-ftp'
import * as fs from 'fs'
import * as path from 'path'
import type { FtpConfig, FtpEntry } from '@/types'
import { normalizeFtpDirectoryName } from './ftp-path'
import { closeFtpSession, connectFtpSession, getFtpConnectionLimit } from './ftp-session'

export { normalizeFtpDirectoryName } from './ftp-path'

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
    if (this.connected && !this.client.closed) return

    try {
      await connectFtpSession(this.client, {
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
    closeFtpSession(this.client)
    this.connected = false
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

    let originalDirectory: string | undefined
    let failed = false
    try {
      originalDirectory = await this.client.pwd()
      await this.enterDirectory(remotePath, originalDirectory)
      const actualDirectory = await this.client.pwd()
      // 先 CWD 验证目录存在，避免服务端对无效 MLSD 路径静默返回空列表。
      const list = await this.client.list()
      return list.map((item) => ({
        name: item.name,
        type: item.isDirectory ? 'directory' : 'file',
        size: item.size,
        modifiedAt: item.modifiedAt || null,
        // 下载和续传必须使用服务器真实目录名，不能再拼回配置中的中文别名。
        path: path.posix.join(actualDirectory, item.name),
      }))
    } catch (error) {
      failed = true
      throw new Error(
        `列出目录失败 ${remotePath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    } finally {
      if (originalDirectory && !this.client.closed) {
        try {
          await this.client.cd(originalDirectory)
        } catch {
          await this.disconnect()
          if (!failed) throw new Error('FTP 工作目录恢复失败，请重新连接后重试')
        }
      } else if (this.client.closed) {
        closeFtpSession(this.client)
        this.connected = false
      }
    }
  }

  private async enterDirectory(
    remotePath: string,
    originalDirectory: string,
  ): Promise<void> {
    const hasNonAscii = (value: string) =>
      Array.from(value).some((character) => character.charCodeAt(0) > 0x7f)
    if (!hasNonAscii(remotePath)) {
      try {
        await this.client.cd(remotePath)
        return
      } catch (error) {
        if (!(error instanceof ftp.FTPError) || error.code !== 550) throw error
      }
    }

    const absolutePath = path.posix.resolve(originalDirectory, remotePath)
    await this.client.cd('/')
    for (const segment of absolutePath.split('/').filter(Boolean)) {
      if (!hasNonAscii(segment)) {
        try {
          await this.client.cd(segment)
          continue
        } catch (error) {
          if (!(error instanceof ftp.FTPError) || error.code !== 550)
            throw error
        }
      }
      // 中文 CWD 可能被服务端替换为问号并进入另一个空目录，必须先匹配真实名称。
      const directories = (await this.client.list()).filter(
        (item) => item.isDirectory,
      )
      const exact = directories.filter((item) => item.name === segment)
      const matches = exact.length
        ? exact
        : directories.filter(
            (item) =>
              normalizeFtpDirectoryName(item.name) ===
              normalizeFtpDirectoryName(segment),
          )
      if (matches.length !== 1) {
        throw new Error(
          `FTP 子目录“${segment}”不存在、无权访问或名称匹配不唯一，请核对 FTP 路径和账号权限`,
        )
      }
      await this.client.cd(matches[0].name)
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
    dataType: 'invention' | 'invention_application' | 'utility_model',
  ): Promise<FtpEntry[]> {
    await this.connect()

    // 根据数据类型确定基础路径
    const basePath =
      dataType === 'invention'
        ? '/发明授权'
        : dataType === 'invention_application'
          ? '/发明申请'
          : '/实用新型'

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
    return this.connected && !this.client.closed
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
  onFileRetry?: (
    fileName: string,
    attempt: number,
    maxAttempts: number,
    error: string,
    localBytes: number,
    remoteBytes: number,
  ) => void
  resume?: boolean
  cancelled?: () => boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getLocalFileSize(localPath: string): number {
  try {
    if (fs.existsSync(localPath)) {
      return fs.statSync(localPath).size
    }
  } catch {}
  return 0
}

export class FtpConnectionPool {
  private config: FtpConfig
  private concurrency: number
  private timeout: number
  private clients: ftp.Client[] = []

  constructor(config?: Partial<FtpConfig>, concurrency?: number) {
    const requested = concurrency ?? Number(process.env.FTP_CONCURRENCY || '3')
    this.concurrency = Math.min(
      Number.isSafeInteger(requested) && requested > 0 ? requested : 3,
      getFtpConnectionLimit(),
    )

    const timeout =
      config?.timeout || parseInt(process.env.FTP_TIMEOUT || '120000')
    this.timeout = timeout
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

  getConcurrency(): number {
    return this.concurrency
  }

  getTimeout(): number {
    return this.timeout
  }

  private async accessClient(client: ftp.Client): Promise<void> {
    await connectFtpSession(client, {
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      secure: this.config.secure,
      secureOptions: { rejectUnauthorized: false },
    })
  }

  async connect(): Promise<void> {
    // 只预连接一个；其余工作连接按需申请，避免多个池互相占住部分额度后等待。
    try {
      await this.accessClient(this.clients[0])
    } catch (error) {
      this.disconnect()
      throw error
    }
  }

  disconnect(): void {
    for (const client of this.clients) {
      try {
        closeFtpSession(client)
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
    let failed = false

    const isCancelled = options?.cancelled ?? (() => false)
    const retryAttempts = Math.max(
      1,
      parseInt(process.env.FTP_RETRY_ATTEMPTS || '3'),
    )
    const retryDelayMs = Math.max(
      0,
      parseInt(process.env.FTP_RETRY_DELAY_MS || '3000'),
    )

    const worker = async (client: ftp.Client) => {
      while (true) {
        if (failed || isCancelled()) return

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

        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
          if (failed || isCancelled()) return
          try {
            // 断点续传：检查本地文件
            if (resume && remoteSize > 0) {
              const localSize = getLocalFileSize(localPath)

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
                break
              }

              // 部分文件存在，从断点续传
              if (localSize > 0 && localSize < remoteSize) {
                await this.accessClient(client)
                if (failed || isCancelled()) return
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
                break
              }

              // 本地文件比远程大，删除重新下载
              if (localSize > remoteSize) {
                fs.unlinkSync(localPath)
              }
            }

            // 全新下载
            await this.accessClient(client)
            if (failed || isCancelled()) return
            if (options?.onFileProgress && remoteSize > 0) {
              client.trackProgress((info) => {
                options.onFileProgress!(
                  entry.name,
                  info.bytesOverall,
                  remoteSize,
                )
              })
            }

            await client.downloadTo(localPath, entry.path)
            client.trackProgress()

            results.push({ entry, localPath, skipped: false })
            completedCount++
            options?.onFileDownloaded?.(
              entry.name,
              completedCount,
              total,
              false,
            )
            break
          } catch (error) {
            client.trackProgress()

            const errorMessage =
              error instanceof Error ? error.message : 'Unknown error'
            const localBytes = getLocalFileSize(localPath)
            const shouldRetry = attempt < retryAttempts && !isCancelled()

            if (shouldRetry) {
              options?.onFileRetry?.(
                entry.name,
                attempt + 1,
                retryAttempts,
                errorMessage,
                localBytes,
                remoteSize,
              )

              closeFtpSession(client)
              await sleep(retryDelayMs)
              continue
            }

            if (!resume && fs.existsSync(localPath)) {
              fs.unlinkSync(localPath)
            }
            throw new Error(
              `下载文件失败 ${entry.path}: ${errorMessage} (local=${localBytes}, remote=${remoteSize}, attempts=${attempt})`,
            )
          }
        }
      }
    }

    const workers = this.clients.map(async (client) => {
      try {
        await worker(client)
      } catch (error) {
        failed = true
        throw error
      } finally {
        closeFtpSession(client)
      }
    })
    try {
      await Promise.all(workers)
    } catch (error) {
      this.disconnect()
      await Promise.allSettled(workers)
      throw error
    }

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
