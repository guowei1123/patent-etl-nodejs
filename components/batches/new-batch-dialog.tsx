'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { Plus, Loader2, FolderOpen } from 'lucide-react'
import { FtpBrowser } from '@/components/ftp/folder-browser'

interface NewBatchDialogProps {
  onSuccess?: () => void
}

const fetcher = (url: string) => fetch(url).then((res) => res.json())

export function NewBatchDialog({ onSuccess }: NewBatchDialogProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showFtpBrowser, setShowFtpBrowser] = useState(false)

  const { data: configData } = useSWR<{
    ftp: {
      data_paths: { invention: string; utility_model: string }
    }
  }>('/api/config', fetcher)

  const dataPaths = configData?.ftp?.data_paths

  const [formData, setFormData] = useState({
    batch_code: '',
    data_type: 'invention',
    ftp_folder: '',
  })

  // FtpBrowser 打开时定位到数据类型对应的 data 根目录
  const browserInitialPath = dataPaths
    ? (formData.data_type === 'invention'
        ? dataPaths.invention
        : dataPaths.utility_model) || '/'
    : '/'

  // 根据 FTP 文件夹路径生成批次编号
  const generateBatchCode = (dataType: string, ftpFolder: string): string => {
    const prefix =
      dataType === 'invention' ? 'CN-PA-TXTS-10-B' : 'CN-PA-TXTS-20-U'
    const folderName = ftpFolder.split('/').filter(Boolean).pop() || ''
    const match = folderName.match(/^(\d{8})(rawdata)?$/i)
    if (match) {
      const date = match[1]
      const suffix = match[2] ? '-Raw' : ''
      return `${prefix}-${date}${suffix}`
    }
    return `${prefix}-${folderName}`
  }

  const handleSubmit = async () => {
    if (!formData.batch_code) {
      toast.error('请输入批次编号')
      return
    }
    if (!formData.ftp_folder) {
      toast.error('请选择 FTP 文件夹')
      return
    }

    // 校验：必须选择 data 目录下的子目录，不能是 data 根目录本身
    const dataRoot =
      formData.data_type === 'invention'
        ? dataPaths?.invention
        : dataPaths?.utility_model
    if (dataRoot && formData.ftp_folder === dataRoot) {
      toast.error('请选择具体的批次子目录，不能选择数据根目录')
      return
    }

    setLoading(true)
    try {
      const response = await fetch('/api/sync/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      })

      const result = await response.json()

      if (result.success) {
        toast.success('批次创建成功')
        setOpen(false)
        setFormData({ batch_code: '', data_type: 'invention', ftp_folder: '' })
        onSuccess?.()
        router.push(`/batches/${formData.batch_code}`)
      } else {
        toast.error(result.error || '启动失败')
      }
    } catch {
      toast.error('请求失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  const handleSelectFolder = (path: string) => {
    setFormData((prev) => ({
      ...prev,
      ftp_folder: path,
      batch_code: generateBatchCode(prev.data_type, path),
    }))
    setShowFtpBrowser(false)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            新建批次
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>创建同步批次</DialogTitle>
            <DialogDescription>
              从 FTP 服务器同步专利数据到本地数据库
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="data_type">数据类型</Label>
              <Select
                value={formData.data_type}
                onValueChange={(value) => {
                  setFormData({
                    batch_code: '',
                    data_type: value,
                    ftp_folder: '',
                  })
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="invention">发明授权</SelectItem>
                  <SelectItem value="utility_model">实用新型授权</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="batch_code">批次编号</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-auto py-1 text-xs"
                  onClick={() =>
                    setFormData((prev) => ({
                      ...prev,
                      batch_code: generateBatchCode(
                        prev.data_type,
                        prev.ftp_folder,
                      ),
                    }))
                  }
                >
                  自动生成
                </Button>
              </div>
              <Input
                id="batch_code"
                placeholder="例如: CN-PA-TXTS-10-B-20231003"
                value={formData.batch_code}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    batch_code: e.target.value,
                  }))
                }
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="ftp_folder">FTP 文件夹</Label>
              <div className="flex gap-2">
                <Input
                  id="ftp_folder"
                  placeholder="选择 FTP 文件夹路径"
                  value={formData.ftp_folder}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      ftp_folder: e.target.value,
                    }))
                  }
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowFtpBrowser(true)}
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              开始同步
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* FTP Browser Dialog */}
      <Dialog open={showFtpBrowser} onOpenChange={setShowFtpBrowser}>
        <DialogContent className="max-h-[80vh] sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>选择 FTP 文件夹</DialogTitle>
            <DialogDescription>
              浏览 FTP 服务器并选择要同步的文件夹
            </DialogDescription>
          </DialogHeader>
          <FtpBrowser
            key={formData.data_type}
            initialPath={browserInitialPath}
            onSelect={handleSelectFolder}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
