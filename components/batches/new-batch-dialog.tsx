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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { Plus, FolderOpen } from 'lucide-react'
import { FtpBrowser } from '@/components/ftp/folder-browser'
import { generateBatchCode } from '@/lib/batch-code'

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
      data_paths: {
        invention: string
        invention_application: string
        utility_model: string
      }
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
    ? dataPaths[formData.data_type as keyof typeof dataPaths] || '/'
    : '/'

  const handleSubmit = async () => {
    if (!formData.ftp_folder) {
      toast.error('请选择 FTP 文件夹')
      return
    }

    // 校验：必须选择 data 目录下的子目录，不能是 data 根目录本身
    const dataRoot = dataPaths
      ? dataPaths[formData.data_type as keyof typeof dataPaths]
      : undefined
    if (dataRoot && formData.ftp_folder === dataRoot) {
      toast.error('请选择具体的批次子目录，不能选择数据根目录')
      return
    }

    setLoading(true)
    try {
      const response = await fetch('/api/sync/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data_type: formData.data_type,
          ftp_folder: formData.ftp_folder,
        }),
      })

      const result = await response.json()

      if (result.success) {
        toast.success('批次创建成功')
        setOpen(false)
        setFormData({ batch_code: '', data_type: 'invention', ftp_folder: '' })
        onSuccess?.()
        router.push(`/batches/${result.data.batch_code}`)
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
            <Plus data-icon="inline-start" aria-hidden="true" />
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

          <FieldGroup className="gap-4 py-4">
            <Field>
              <FieldLabel htmlFor="data_type">数据类型</FieldLabel>
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
                <SelectTrigger id="data_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="invention">发明授权</SelectItem>
                    <SelectItem value="invention_application">发明申请</SelectItem>
                    <SelectItem value="utility_model">实用新型</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="batch_code">批次编号</FieldLabel>
              <Input
                id="batch_code"
                readOnly
                placeholder="选择 FTP 文件夹后自动生成"
                value={
                  formData.ftp_folder
                    ? generateBatchCode(formData.data_type, formData.ftp_folder)
                    : ''
                }
                className="bg-muted/50"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="ftp_folder">FTP 文件夹</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="ftp_folder"
                  placeholder="选择 FTP 文件夹路径"
                  value={formData.ftp_folder}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      ftp_folder: e.target.value,
                      batch_code: generateBatchCode(
                        prev.data_type,
                        e.target.value,
                      ),
                    }))
                  }
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    variant="outline"
                    size="icon-sm"
                    onClick={() => setShowFtpBrowser(true)}
                    aria-label="选择 FTP 文件夹"
                  >
                    <FolderOpen aria-hidden="true" />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={loading}>
              {loading && <Spinner data-icon="inline-start" />}
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
