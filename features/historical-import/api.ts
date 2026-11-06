import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { z } from 'zod'
import { configSchema, type ImportConfig } from './model'
import {
  createJob,
  getJob,
  listJobs,
  pythonPath,
  jobRoot,
  validateSources,
} from './jobs'
import { readFile } from 'node:fs/promises'
import { jobDirectory } from './jobs'
import { cleanupCandidates, cleanupObjects } from './cleanup'
import { previewImages } from './preview-images'

async function inspectSources(config: ImportConfig) {
  await validateSources(config)
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(
      pythonPath(),
      [
        path.resolve('features/historical-import/prepare.py'),
        '--config',
        '-',
        '--output',
        jobRoot,
        '--inspect',
      ],
      {
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('来源检查超时，请缩小来源目录范围'))
    }, 60000)
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
      if (output.length > 2000000) {
        child.kill()
        reject(new Error('来源字段过多，请缩小检查范围'))
      }
    })
    child.stderr.resume()
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('无法启动 Python，请按模块 README 安装依赖'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error('来源检查失败，请检查文件格式、工作表和 Python 依赖'))
        return
      }
      try {
        resolve(JSON.parse(output))
      } catch {
        reject(new Error('来源检查没有返回有效结果'))
      }
    })
    child.stdin.end(JSON.stringify(config))
  })
}

export async function historyGET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id')
    const report = request.nextUrl.searchParams.get('report')
    const publication = request.nextUrl.searchParams.get('publication')
    if (id && publication) {
      const preview = await previewImages(
        id,
        publication,
        request.nextUrl.searchParams.get('image'),
      )
      if (preview.content)
        return new NextResponse(new Uint8Array(preview.content), {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'private, no-store',
          },
        })
      return NextResponse.json({ success: true, data: preview.data })
    }
    if (id && report) {
      if (!['results.jsonl', 'source-errors.jsonl'].includes(report))
        throw new Error('报告无效')
      return new NextResponse(
        await readFile(path.join(jobDirectory(id), report)),
        {
          headers: {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Disposition': `attachment; filename="${report}"`,
          },
        },
      )
    }
    if (id && request.nextUrl.searchParams.get('cleanup') === 'true') {
      await getJob(id)
      return NextResponse.json({
        success: true,
        data: await cleanupCandidates(id),
      })
    }
    return NextResponse.json({
      success: true,
      data: id ? await getJob(id) : await listJobs(),
    })
  } catch {
    return NextResponse.json(
      { success: false, error: '无法读取历史任务，请刷新页面或检查任务编号' },
      { status: 400 },
    )
  }
}

export async function historyPOST(request: NextRequest) {
  const origin = request.headers.get('origin')
  if (origin && origin !== request.nextUrl.origin)
    return NextResponse.json(
      { success: false, error: '请从当前工作台发起操作' },
      { status: 403 },
    )
  try {
    const body = await request.json()
    const action = z
      .enum(['inspect', 'preview', 'import', 'cleanup'])
      .parse(body.action)
    if (action === 'cleanup') {
      const job = await getJob(z.string().uuid().parse(body.jobId))
      if (
        job.mode !== 'import' ||
        !['completed', 'failed'].includes(job.status)
      )
        throw new Error('请等待导入任务结束后清理')
      return NextResponse.json({
        success: true,
        data: await cleanupObjects(
          job.id,
          z.array(z.string()).min(1).max(100).parse(body.keys),
        ),
      })
    }
    if (action === 'import') {
      const preview = await getJob(z.string().uuid().parse(body.previewId))
      if (
        preview.mode !== 'preview' ||
        preview.status !== 'completed' ||
        preview.summary.ready === 0
      )
        throw new Error('请先完成预览，并补齐至少一件可导入文献')
      return NextResponse.json(
        { success: true, data: await createJob(preview.config, 'import') },
        { status: 202 },
      )
    }
    const config = configSchema.parse(body.config)
    if (action === 'inspect')
      return NextResponse.json({
        success: true,
        data: await inspectSources(config),
      })
    return NextResponse.json(
      { success: true, data: await createJob(config, 'preview') },
      { status: 202 },
    )
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof z.ZodError
            ? '配置不完整，请检查路径、列名、日期和处理数量'
            : error instanceof Error
              ? error.message
              : '无法创建任务，请检查配置',
      },
      { status: 400 },
    )
  }
}
