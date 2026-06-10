import * as fs from 'fs'
import * as path from 'path'

function getTempRoot(): string {
  if (process.env.TEMP_DIR) {
    return path.resolve(/* turbopackIgnore: true */ process.env.TEMP_DIR)
  }
  return path.join(/* turbopackIgnore: true */ process.cwd(), 'data')
}

export function ensureTempDir(): string {
  const tempDir = getTempRoot()
  if (!fs.existsSync(/* turbopackIgnore: true */ tempDir)) {
    fs.mkdirSync(/* turbopackIgnore: true */ tempDir, { recursive: true })
  }
  return tempDir
}

export function resolveTempPath(subdir?: string): string {
  const base = path.resolve(/* turbopackIgnore: true */ ensureTempDir())
  if (!subdir) return base
  if (path.isAbsolute(subdir)) {
    throw new Error('临时目录子路径不能是绝对路径')
  }

  const targetPath = path.resolve(
    /* turbopackIgnore: true */ base,
    /* turbopackIgnore: true */ subdir,
  )
  const relative = path.relative(
    /* turbopackIgnore: true */ base,
    /* turbopackIgnore: true */ targetPath,
  )
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('临时目录子路径超出允许范围')
  }

  return targetPath
}

export function getTempPath(subdir?: string): string {
  const fullPath = resolveTempPath(subdir)
  if (!fs.existsSync(/* turbopackIgnore: true */ fullPath)) {
    fs.mkdirSync(/* turbopackIgnore: true */ fullPath, { recursive: true })
  }
  return fullPath
}

export function cleanTempDir(subdir?: string): void {
  const targetPath = resolveTempPath(subdir)
  if (fs.existsSync(/* turbopackIgnore: true */ targetPath)) {
    fs.rmSync(/* turbopackIgnore: true */ targetPath, {
      recursive: true,
      force: true,
    })
  }
}

export function getTempDirState(subdir: string): {
  path: string
  exists: boolean
  hasFiles: boolean
} {
  const targetPath = resolveTempPath(subdir)
  if (!fs.existsSync(/* turbopackIgnore: true */ targetPath)) {
    return { path: targetPath, exists: false, hasFiles: false }
  }

  return {
    path: targetPath,
    exists: true,
    hasFiles: fs.readdirSync(/* turbopackIgnore: true */ targetPath).length > 0,
  }
}
