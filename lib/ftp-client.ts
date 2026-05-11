import * as ftp from 'basic-ftp'
import * as fs from 'fs'
import * as path from 'path'
import type { FtpConfig, FtpEntry } from '@/types'

export class FtpClient {
  private client: ftp.Client
  private config: FtpConfig
  private connected: boolean = false

  constructor(config?: Partial<FtpConfig>) {
    this.client = new ftp.Client()
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
    onProgress?: (bytes: number, total: number) => void,
  ): Promise<void> {
    await this.connect()

    // 确保本地目录存在
    const localDir = path.dirname(localPath)
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true })
    }

    try {
      // 获取文件大小用于进度报告
      const fileInfo = await this.client.size(remotePath).catch(() => 0)

      if (onProgress && fileInfo > 0) {
        this.client.trackProgress((info) => {
          onProgress(info.bytes, fileInfo)
        })
      }

      await this.client.downloadTo(localPath, remotePath)

      this.client.trackProgress() // 停止进度跟踪
    } catch (error) {
      // 清理可能部分下载的文件
      if (fs.existsSync(localPath)) {
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
    filter?: (entry: FtpEntry) => boolean,
    onFileDownloaded?: (fileName: string, index: number, total: number) => void,
  ): Promise<string[]> {
    await this.connect()

    const downloadedFiles: string[] = []

    // 确保本地目录存在
    if (!fs.existsSync(localPath)) {
      fs.mkdirSync(localPath, { recursive: true })
    }

    const entries = await this.listDirectory(remotePath)
    const filesToDownload = entries.filter(
      (e) => e.type === 'file' && (!filter || filter(e)),
    )

    for (let i = 0; i < filesToDownload.length; i++) {
      const entry = filesToDownload[i]
      const localFilePath = path.join(localPath, entry.name)

      await this.downloadFile(entry.path, localFilePath)
      downloadedFiles.push(localFilePath)

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
